# 🌍 Xyzo — Global News Intelligence Map

**Every day, half a million news articles are published worldwide.**

Xyzo digs them up, figures out *where* things happened, *who* is involved, and *what* it means — then shows you everything on a single map.

Think of it as **Google News meets a knowledge graph**, except you can see patterns across 160+ countries in real-time.

---

## TL;DR — Start Here

```bash
# 1. Setup
git clone https://github.com/htmlfarmer/xyzo.org.git
cd xyzo.org
bash scripts/setup.sh

# 2. Run the pipeline
python3 -m worker.run --fast   # Fetch news sources

# 3. Try it
curl http://localhost:3008/api/health
open http://localhost:3008
```

**Works out of the box** with no configuration needed for basic use.

---

## ⚠️ Update this file before you close a session

**Always update `README.md` when you change *anything* — a new overlay,
a fixed bug, a swapped licence, a new test, a changed number.** This
file is how the next session, the next reviewer and the close-out all
learn what is currently true. A change that lands without its README
line makes every other line in here suspect, and turns the close-out
into archaeology.

The minimum, every single time:

| | |
|---|---|
| **1. `## System Health`** table | one row: what changed, ✅ fixed or ✅ shipped, and the one sentence a stranger needs |
| **2. `## Data Quality & Provenance`** table | if it touched a dataset or a licence: source, licence, and the `verify()` that gates it |
| **3. The affected overlay's section** | the new numbers, the new command, and the trap you just learned |
| **4. `## Known Issues`** | anything you did **not** fix, with its impact and where it hurts |

Then run `bun test public_html/tests/*.bun.test.js` and say so.

A close-out is **"the docs match the code and the tests are green"** —
not "I remember what I did". The README is written *during* the change,
not reconstructed afterwards.

**Latest run (2026-11-14, the security gates — the close-out):**
frontend **1832 pass / 0 fail** (104 files) · **pytest
`tests/test_security_check.py` → 8 passed** · **the security gate: 0
gated findings, 0 new, 28 report-only, secrets ✓ clean** · `bash
scripts/ci.sh --only security` → **✅ 0 failures (baseline 0)** ·
`validate-api.sh --quick` → **ALL CHECKS PASSED**. The **secrets** side
had a real gate all along (the global git hooks on every commit and
every push, plus `secretz`); the **SQL-injection-and-friends** side did
not, and now does — see *The Security Gates* below and **Q-N50** for
what it still does not cover.

**Latest run (2026-11-14, the "clear the map" button + the low-res tier
+ a full review of the day's changes):**
frontend **1832 pass / 0 fail** (104 files) — the rewritten
**`default-map-button.bun.test.js`** (the owner's satellite hash, the
base, and the **"no overlays"** contract), the extended
**`map-presets.bun.test.js`** (the tier, the light map, the global-view
rule and **the chips-wrap fix**) and **`isobar-delta-url.bun.test.js`
(19)** — the `delta=` segment, the order it is applied in, the
`persist: false` rule, the repaint-without-a-click, the saved style,
the preset grammar, the pasted-link path and **the field cache**. The
`?v=` tokens moved as one build (`bash scripts/bump_frontend.sh
202611142000`). **Measured live** by the new
**`scripts/default_map_check.py`** (Playwright, the live site, a slow
machine's `deviceMemory`/`hardwareConcurrency`/`saveData` stubbed before
the page's scripts run): the showcase opens with **13 overlays · 250
requests · 4.7 MB**, the **satellite view with 0 overlays · 130 requests
· 2.6 MB**, and the 🛰️ button leaves **0 overlays** on the satellite
basemap at zoom 2 — **0 page errors**. **THE REVIEW FOUND ONE MORE
DEFECT**: the change map **re-fetched its 130 KB field on every pan**
(four pans, four extra fetches) — the field is the whole world and does
not change with the viewport, so it is now cached against its window
and a pan re-contours from the cache: **ONE fetch for the whole
session**, and the lines still redraw (395 → 364). The button's own
section is below.

**Latest run (2026-11-14, the change map's window in the URL):**
frontend **1824 pass / 0 fail** (104 files) — **+15** in one new file
(**`public_html/tests/isobar-delta-url.bun.test.js`** — the `delta=`
segment, the order it is applied in, the `persist: false` rule, the
repaint-without-a-click, the saved style, the preset grammar and the
pasted-link path; it is **19** now, after the review added the field
cache). The `?v=` tokens moved as one build
(`bash scripts/bump_frontend.sh 202611141500`). **Measured live** by the
new **`scripts/isobar_delta_url_check.py`** (Playwright, the live site):
the click moves the URL to `…/isoSrc=auto/delta=24h`, switching back to
"pressure" **drops** the segment, a **cold** link opens on the change map
with the chip active while the reader's own stored window survives, and a
link **pasted into an open tab** applies it too — **0 page errors**. The
change map's own section is below.

**Latest run (2026-11-14, the wind's speed on Firefox + perf telemetry):**
frontend **1809 pass / 0 fail** (103 files) — **+28** in two new files
(**`wind-slow-devices.bun.test.js` (12)** — the 0.25 s dt cap, the
dt-scaled flow, the three concentric FILLS and the fps tip;
**`perf-report.bun.test.js` (16)** — the payload diffed against the
route's Zod schema, the once-a-day guard, the cadence maths) — plus the
globe's parity test **rewritten for the fills** (the globe paints the
same three discs now). API: **`api/tests/client-perf.test.ts` (11,
new)** → 11/11, neighbours → 19/19. `bash scripts/validate-api.sh
--quick` → **ALL CHECKS PASSED**, and the migration
`2026-11-14-client-perf.sql` is applied to `xyzo` and `xyzo_test` with
`xyzo_app` granted inside it. **Measured live:** both telemetry phases
POST **200**, the wind legend reads **"1,234 dots · 8 fps"** with the
tip showing, **0 page errors**; `scripts/globe_wind_audit.py` → the
globe's animation still draws, 0 console errors. The fix's own numbers
(before/after) are in *Wind Speed on Firefox* below.

**Latest run (2026-11-13, the default map + the live feed's tab strip):**
frontend **1781 pass / 0 fail** (101 files) — **+22** in two new files
(**`default-map-button.bun.test.js` (11)** — the 🛰️ button, the owner's
hash verbatim, the satellite base layer, and the phone-width rule that
keeps the ⚙ on screen; **`live-panel-tabs.bun.test.js` (11)** — the
grid, the one-line labels, the **windowed** AI query and its three-day
cap, the honest confidence badge) — plus **`tour.bun.test.js` (20)**
rewritten for the **opt-in** contract. `bash scripts/validate-api.sh
--quick` → **ALL CHECKS PASSED**. Measured on the live site by the new
**`scripts/live_panel_audit.py`** (Playwright: desktop, a 393×852 phone
and the largest text size): **before**, "🤖 AI Suggested" broke into
**four lines** and the strip overflowed the panel by **14 px**; the tab's
query was **still running after 13 minutes**; **after**, every label is
on **one line**, the strip does not overflow, the AI tab answers in
**0.4–2 s** with **30 cards that say where they are**, and the 🛰️
button puts the owner's map on the screen.

**Latest run (2026-11-12, the phone-popup fix):** frontend **1696 pass /
0 fail** (91 files) — **+16** in `public_html/tests/search-mobile-popup.bun.test.js`
(the popup after a search on a phone: the framing's SIGN, the settle
wait, the status-line reservation, the dead mobile Details button, the
wired restore, the canvas shift hack, the cluster double-count and the
tour). Measured on the live site by the new **`scripts/search_mobile_audit.py`**
(a 393×852 phone profile with real touch): **before, 4 of 9 checks
failed** (the popup at 558,−474 → 927,−94, the ✕ 464 px above the top of
the screen); **after, 9 of 9 pass** (the popup at 10,215 → 379,595, still
for 1.5 s, and the ✕ closes it) — chicago · tokyo · new york, four runs.

**Latest run (2026-11-11, the coverage sweep):** frontend **1663 pass /
0 fail** (88 files), `api/tests/weather-isobars.test.ts` **20 pass / 0
fail**, `bash scripts/validate-api.sh --quick` → **ALL CHECKS
PASSED**. **8 new tests**, each MUTATION-CHECKED (the protection
removed, the test observed failing, then restored): **+4 API** — the
no-build-record half of the validator (a changed row set must not be
answered 304, and `total_lines` must move with it so the counts cannot
be served from a cache that did not), plus `source=auto` and the
"unpublished analysis falls back rather than blanking the layer"
server path, which had no test at all because every request in the file
named `gfs` explicitly; **+1** — the globe must fetch the isobars for
the **whole world**, never a viewport bbox (the exact input to the
flat map's dateline bug); **+3** — `rewrapLines()` is now EXECUTED for
both layers instead of only source-pinned, covering the fly-off-the-
dateline path a fresh load never exercises. `_rewrapLines` is exported
from both modules for it. **This supersedes the line below.**

**Latest run (2026-11-11, after the vacuum):** frontend **1638 pass /
0 fail** (88 files), `api/tests/weather-isobars.test.ts` **16 pass / 0
fail**, `bash scripts/validate-api.sh --quick` → **ALL CHECKS
PASSED**. `weather_isobars` **0 dead tuples / 241 MB**, both metadata
queries **Index Only Scan, Heap Fetches 0, 6.3–7.0 ms**. **This
supersedes the line below.**

**Latest run (2026-11-11, the coverage audit):** `bun test
public_html/tests/*.bun.test.js` → **1659 pass / 0 fail** (89 files) —
**7 new**: the wind's Pacific guard (behavioural, mutation-checked), the
console-guard's Firefox patch (behavioural, mutation-checked, a new
file), the river-labels default on **both** layers (behavioural,
mutation-checked). See **"What Is Covered, and How"** below for the
map of which test proves what.

**Latest run (2026-11-11, the API banner's X):** `bun test
public_html/tests/*.bun.test.js` → **1638 pass / 0 fail** (88 files) —
**2 new** in `offline-notice-dismiss.bun.test.js` (the "Live data is
unavailable" banner carries the house ✕, and its dismissal is
remembered for the session, not cleared by the click, and forgotten
when the situation resolves).

**Latest run (2026-11-10, the isobar speedup):** `bun test
api/tests/weather-isobars.test.ts` → **16 pass / 0 fail** (+3, the
validator), `bun test public_html/tests/*.bun.test.js` → **1638 pass /
0 fail** (88 files), `bash scripts/validate-api.sh --quick` → **ALL
CHECKS PASSED**. API restarted, `xyzo-api` active, `/api/health` 200 in
1.9 ms. **This supersedes the line below.**

**Latest run (2026-11-10, the dateline — isobars + faults):** `bun test
public_html/tests/*.bun.test.js` → **1636 pass / 0 fail** (88 files).
**5 new** — `fault-layer.bun.test.js` (+2: `viewSpans` and `wrapLine`
EXECUTED, not grepped) and `isobar-layer.bun.test.js` (+3: the same two
helpers plus a PARITY test that runs four inputs through both modules'
copies and demands identical output). **This supersedes both lines
below**: the `wind-density` failure the first one records was that
file mid-build and is green, and the second line's own note says the
same.

**Latest run (2026-11-10, the Pacific wind):** `bun test
public_html/tests/*.bun.test.js` → **1630 pass / 1 fail** (88 files) —
**the 1 failure is in `wind-density.bun.test.js`**, the other session's
wind-density control, mid-build in this shared tree. **2 new** in
`wind-layer.bun.test.js`: the fixed longitude window must not come back,
and the particle guard must be measured against the view's window.

**Latest run (2026-11-10, the wind density control):** `bun test
public_html/tests/*.bun.test.js` → **1631 pass / 0 fail** (88 files). **This tree is being
edited by two sessions at once**: the previous run recorded **1627 / 1 fail**, and the failure
was in `wind-density.bun.test.js` — this change's own file, mid-build. **It is green now**
(26 tests in that file), so the earlier note is superseded: no failing test belongs to either
change. The suites each change touches individually are also green.

**Latest run (2026-11-10, the layer keys):** `bun test
public_html/tests/*.bun.test.js` → **1617 pass / 5 fail** (88 files) —
**the 5 failures are NOT this change**: they are in
`wind-density.bun.test.js`, **another session's in-flight wind-density
work** (a slider and a number box for the wind's dot count) in the same
working tree — this tree is being edited concurrently, and the rivers'
`meta.json` was rewritten under the licence test while this ran. **Every
test touching this change passes**, including the 5 new assertions in
`hwsd-layer.bun.test.js` (the key must not use `var(--fg)`, the names are
≥12px, the swatches have an edge, no name is cut off, the key is
revealed on enable). `scripts/legend_contrast_check.py` → **all 22 keys
readable** (the worst is 4.83:1). **SUPERSEDED**: the 5 failures it
records were `wind-density.bun.test.js` mid-build, and that file is
green in the run above — nothing in this tree is failing.

**Latest run (2026-11-13, the CHANGE map):** `bun test
public_html/tests/*.bun.test.js` → **1759 pass / 0 fail** (89 files) —
7 new in `delta-contour.bun.test.js` (the levels come from the field's own
range, a cell range does not change the lines, the blur is the live
chart's blur and it removes lines, a saddle cell cuts two segments, and
the cell range wraps in longitude). The measurement is
`scripts/delta_chart_check.py` (the change map's **long tasks**) and
`scripts/isobar_speed_check.py` (the ordinary chart's).

**Latest run (2026-11-10/11, the search, the saved searches and the
layer keys):** `bun test public_html/tests/*.bun.test.js` → **1659 pass /
0 fail** (89 files). **API:** `cache.test.ts` (14) +
`pins-search-wordmatch.test.ts` (3) + `tags-structural.test.ts` (1) →
**38 pass / 1 fail** in that group, and the one failure is
**pre-existing and not this work** (`POST /api/ai/chat > returns 400 for
missing message` — it fails against the pre-fix code too ✗). **Worker:**
`test_extract_topic_tags.py` (9) + `test_extract_batch.py` → **13 pass /
0 fail**. The coverage map is in **## Testing** above.

**Latest run (2026-11-09, the saved searches):** `bun test
public_html/tests/*.bun.test.js` → **1592 pass / 0 fail** (87 files) —
13 new (`saved-searches.bun.test.js`: the store is disk and not memory,
it is capped, the key carries the time WINDOW, the saved answer is
painted before the slow query is awaited, and the server's copy is
byte-budgeted).

**Latest run (2026-11-09, the search region):** `bun test
public_html/tests/*.bun.test.js` → **1579 pass / 0 fail** (86 files) —
25 in `search-region.bun.test.js` (a point of interest is not a region,
the region comes from the stories, the world threshold, the early
framing, and the corroboration rule),
`search-place-navigation.bun.test.js` rewritten against the shared
`frameSearchRegion()` — **the same assertions, a new home** (the place
gate, the extent cap and the box-centre agreement used to be read out of
two copies of the logic) — plus **2 new API test files**
(`pins-search-wordmatch.test.ts`, `tags-structural.test.ts`), both
mutation-checked.

**Latest run (2026-11-09, basins outlines):** `bun test
public_html/tests/*.bun.test.js` → **1557 pass / 0 fail** (85 files) —
2 new (the outline's own opacity base, and the scheme parity with the
flat map). **Two existing tests failed first, and they were wrong:**
globe-overlay-opacity pinned `line-opacity` to the FILL's base, which
is precisely the bug, while the same file's header says the basins
should be *"a hairline over terrain you can still read"* and its own
reference test asserts the flat map's **0.85** — the assertions and
their stated intent disagreed. Both rewritten.

**Run 2026-11-09 (the satellite popup + the console):** `bun test
public_html/tests/*.bun.test.js` → **1560 pass / 0 fail** (85 files) —
2 new (the satellite mini map's host is found through the popup's OWN
element, never by a document-wide id lookup, because the popup pane can
hold **two** satellite popups at once — the one fading out for 200 ms
after its close — and Leaflet refuses to initialise a container that
already has a map; and the **token gate**: every `<script src>` in
index.html must carry a `?v=` and be in `bump_frontend.sh`'s ASSETS,
because a `*.js` is served `immutable` for a YEAR and an unstamped one
can never update — **16 of them had no token at all**).

**Run 2026-11-08 (the first-visit map):** `bun test
public_html/tests/*.bun.test.js` → **1551 pass / 5 fail** (85 files) —
**THE 5 WERE NOT THAT CHANGE**: they were in `globe-wind.bun.test.js` (3)
and `offline-layer.bun.test.js` (2), another session's in-flight
`globe-wind.js` / `sw.js` work. Stashing **only** the first-visit
change's three files and re-running gave the **same 5**; stashing
everything gave **1547 pass / 0 fail** on the pre-existing tree.

**Run 2026-11-08 (earlier):** `bun test public_html/tests/*.bun.test.js`
→ **1543 pass / 0 fail** (85 files). Added on 11-08: the tile mirror's
assertion moves — three sets of tests now read
`api/src/routes/tileMirror.ts`, because their URLs moved server-side and
**a test pointed at a file that no longer holds the URL passes forever**.

**Run 2026-11-07:** `bun test public_html/tests/*.bun.test.js`
→ **1541 pass / 0 fail**. Added then: the
**real-slug handoff gate** in `panel-parity.bun.test.js` — it runs the
SHIPPED `getLayerSlug()` over each globe overlay's label instead of
round-tripping the globe's own key (that round trip passes whenever
there is *no* alias, which is exactly how five vocabulary mismatches
shipped) — plus the owner's own 15-overlay link as a case, the
`registerGlobeKeys` / carry-through contract in
`view-handoff.bun.test.js`, a **behavioural** `overlay-opacity` test
that `get()` prefers a link's view override over the stored preference,
and the **dark-halo gate** over all three animated wind renderers in
`wind-styles.bun.test.js` (mutation-checked: recolour the particles'
halo and it fails). `overlay-opacity.bun.test.js` now passes **on its
own** too (it used to need another test file to leak a `window` into
global scope first). Live gates: `scripts/globe_audit.py` → **21/21**,
`scripts/globe_handoff_check.py` → **6/6** (was 2/6),
`scripts/shared_link_parity.py` → **0 lost** both ways,
`scripts/overlay_opacity_probe.py` → **0 of 20** overlays wrong,
`scripts/wind_cache_check.py` → **6/6** scenarios animating.

**Run 2026-11-06:** `bun test public_html/tests/*.bun.test.js`
→ **1530 pass / 0 fail** (85 files — including the **28 new
`map-failed-notice.bun.test.js`** for the "The map didn't load."
notice: its detection, its guard rails and the `readyState` trap, plus
the **re-pointed `hard-refresh.bun.test.js`** asserting `hardRefresh`
now lives in `offline.js` and that the script tag order puts it before
`app.js`), and the **30
`isobar-step.bun.test.js`** pinning the eight-chip ladder and the new
**cross-file invariant** (*every* `STEP_CHOICES` entry must be a whole
multiple of `ISO_INTERVAL_HPA`, so a chip can never claim a step the
published lattice cannot serve), and the **30
`fao-rivers-layer.bun.test.js`** pinning the 2026 river layer's detail
levels, its tile sources, the proxy's contract **and the standard tile
grid** (the `tileSize: 512` trap), and the **9 new
`control-windows-start-closed.bun.test.js`** pinning both panels'
start state, the tab-order fix and the tour's target lists).
`api/tests/tile-proxy.test.ts` → **10 pass / 0 fail**.
`api/tests/fao-rivers-proxy.test.ts` → **8 pass / 0 fail** (including the
disk-cache sweeper).
*(Previous run 2026-11-05: 1487 pass / 0 fail, 83 files — including the
**27 new `hwsd-layer.bun.test.js`**, the **13 `soil-layer.bun.test.js`**
(three of them new for the USDA chip + the switcher fix), the FAO rivers
work, and the `panel-parity` scanner fix that made
`const LAYER_NAME = "…"` modules visible to the parity contract).*
`api/tests/image-proxy.test.ts` → **6 pass / 0 fail**.
The Playwright audits → `scripts/probe_audit.py` (**NEW**: a pointer
sweep over 51 positions on the live map — **no two readouts overlap,
nothing runs off the screen, and every wind reading matches the
published grid**, which the audit samples independently in Python),
`scripts/tour_audit.py` (the tour: it shows
itself, every step has text, the spotlight lands on its target, the
card never covers it, it does not come back, a shared link does not
trigger it, and it survives a resize — **all green**),
`scripts/ocean_current_audit.py` (the live currents, **four ways in**:
the default load, a shared link, a checkbox click and after a pan —
**all four advance, the console clean**), and the new
`scripts/image_proxy_audit.py` (**28 image-proxy responses on a live
page load → all 200; 400 stored URLs → all 200; no console errors**).
`worker/tests/test_image_pipeline.py` → **45 pass / 0 fail**
(was 27/39 — the image-URL repairs are now pinned).
`worker/tests/test_gfs_verify.py` + `worker/tests/test_gfs_verify_isobars.py`
→ **40 pass / 0 fail** (the
isobar check now reads the field the lines were cut from, and five new
synthetic tests prove the gate still **fails** on a broken set — at the
**restored 0.4 hPa tolerance**, with the single-cell displacement test
back to ONE cell).
`worker/tests/test_isobars.py` → **48 pass / 0 fail** (the 0.5 hPa
interval, the superset property and the float-level loop).

**Two migrations were applied to production on 2026-11-05:**
`api/migrations/2026-11-05-weather-isobars-half-hpa.sql`
(`level_hpa` INTEGER → REAL, for 1000.5) and
`api/migrations/2026-11-05-weather-isobars-build.sql` (a one-row-per-
source record of the build parameters, so a resolution or interval
change is not mistaken for "already published"). The API was restarted
to pick up the new `step` enum — **`api/src/` changes need
`systemctl restart xyzo-api`**, and after the restart
`bun test api/tests/weather-isobars.test.ts` → **10 pass / 0 fail**
(`XYZO_DB_URL` from `api/.env.test`, not `XYZO_DB_DSN`).
`api/tests/weather-isobars.test.ts` → **10 pass / 0 fail**.
`bash scripts/validate-api.sh` → **ALL CHECKS PASSED** (one run hit the
TTFP SLA at 4830 ms against a 4000 ms threshold while the worker test
suite was running on the same box; two clean runs afterwards measured
**3765 ms and 3664 ms** — a load flake, not a regression).
The full `worker/tests/` suite → **999 pass / 11 fail** (39 skipped, 2
xfailed), and all eleven failures are **pre-existing** and in files this
session did not touch (`test_ai_client.py` ×2,
`test_location_id_backfill.py`, `test_news_source_addition.py` ×4,
`test_service_events_api.py` ×2, `test_source_quality.py`,
`test_video.py`) — environment and schema-drift issues, not regressions.
The full `worker/tests/` suite → **983 pass / 9 fail** (39 skipped, 2
xfailed), and all nine failures are **pre-existing** and in files this
session did not touch (`test_ai_client.py` ×2,
`test_location_id_backfill.py`, `test_news_source_addition.py` ×3,
`test_service_events_api.py` ×2, `test_source_quality.py`) —
environment and schema-drift issues, not regressions.

**The climate-data verification of 2026-11-04** (owner ask: *"check that
we are getting the latest climate data… verify the wind direction is
correct… verify all these maps"* and *"im not really following why our
maps look so different from windy… shouldn't they be very similar or
better?"*). Full measurements: **`docs/CLIMATE_ACCURACY_2026-11-04.md`**.

| question | answer |
|---|---|
| are the overlays fresh? | **yes** — wind GFS 18Z→00Z, temperature 18Z, isobars 18Z, all within a minute of their 6-hourly timer; the files revalidate over HTTP (ETag + `Last-Modified`, no `immutable`) |
| is the wind grid the real GFS analysis? | **yes** — **65,160 cells compared against the raw GRIB message, max diff 0.0042 m/s, 0 cells over tolerance** |
| is the wind direction right? | **yes** — `from = atan2(−u, −v)`; **51 pointer positions checked against the published grid in Python, every bearing within the compass point's own 22.5°**; a median **24.1°** off the geostrophic wind with **85.4 %** of the flow towards the low; the **mirrored-wind control is DETECTED** |
| are the isobars right? | **yes** — the pressure read on a served line matches that line's own level to **+0.005 hPa mean, 0.029 hPa p95** |
| do they match windy.com? | **not exactly, and now the reader can see why** — windy.com draws **ECMWF 9 km**; the map drew **GFS 0.25°** because the API picks the newest analysis covering the view. At a point the two models agree to **7° / 0.6 °C / 0.6 hPa** — but the *lines* are a median **215 km** apart, because 0.6 hPa in a weak gradient moves an isobar hundreds of kilometres. **There is now an analysis picker** (`Auto · ECMWF · GFS · HRRR`), the choice travels with the link (`/isoSrc=ecmwf`), and the **wind and temperature are now published at 0.25°** instead of 1° (the 1° wind was **78° wrong at Nairobi**) |

---

The map's top-right stack icon opens the **layers dropdown** — **43
rows**: 8 base layers, the **⛅ pressure lines**, **32 overlays**, the
**📍 Markers** switch and the **🔗 Story links** switch. Every overlay
has its own opacity slider and a dotted leader, so you can tell which
slider belongs to which name:

| | | |
|---|---|---|
| ⛅ Pressure lines (isobars) | 🛰️ NASA Satellite (True Color) | 🌧️ NASA Rain Rate (IMERG) |
| 🤝 Facebook Friendships | 🌌 NASA Earth at Night | 🌍 Köppen Climate |
| 🌡️ Temperature (GFS) | 💨 Wind (GFS) | 🌬️ Wind speed (GFS) |
| ⛈️ Convective instability (CAPE) | 🌊 Moisture transport (IVT) | 🧍 Population density (WorldPop, 1 km) |
| ⚡ Lightning density (WWLLN) | 🦠 Phytoplankton (Darwin) | 🌍 Languages |
| 🟫 Soil (SoilGrids) | 🌾 Cropland (ESA) | 🗺️ Land Cover (ESA) |
| 💧 Rivers | 🧭 Magnetic Field (WMM) | 🛰️ Human Transportation |
| 🧂 Sea surface salinity | 🌊 Ocean Currents (ECCO) | 🌊 Hydrological Basins |
| 🪨 Geology (Macrostrat) | 🗺️ Geologic contacts (USGS) | ⛰️ Relief (ETOPO) |
| 🌊 Wave height & power | 🏙️ City names | 🌊 **Ocean currents (OSCAR)** |
| 🌐 **Earthquakes (USGS)** | 🪨 **Tectonic faults (USGS)** | 🌍 **Language regions** |

The **📍 Markers** switch turns every pin off at once. The panel
stays open until you
close it with its **✕** (it no longer collapses on an outside click),
and it starts **collapsed on a phone** — a floating panel on a 390 px
screen covers the whole map.

The globe link (ringed-planet icon under the zoom buttons) opens the
**3D globe** at `/globe`, which remembers your overlay and projection
settings across visits and carries **the same overlays** — the wind
animation, the wind speed field, the live currents, the earthquakes,
the faults and the language regions included.

A **first visit** is met with a short **guided tour** — six steps that
point at the layers dropdown, the search bar, the live feed, the globe
button and the ⚙ menu. It shows itself **once**, and it is a button
afterwards: ⚙ → TOOLS → **How to**, or the help panel → **Show me how
this works**.

---

## What Is Covered, and How (2026-11-11)

Owner ask: *"do we have some test cases to cover all these things we
might have changes?"* **Every change of this round has a test, and the
tests are graded by what they actually PROVE** — because a test that
only reads the source proves the wiring, not the behaviour.

| The change | The test | What it proves |
|---|---|---|
| **The first visit opens the owner's 15-overlay map** | `map-presets.bun.test.js`, `new-features.bun.test.js` | **behavioural** — the preset module is RUN and its hash parsed; plus the live check |
| **The Pacific wind (the fixed longitude window)** | `wind-physics.bun.test.js` | **behavioural** — the module is run in a Web-Mercator sandbox centred west of the dateline and the DRAWN TRAILS are read back: with the old guard **nothing is painted west of the antimeridian** (mutation-checked) |
| **The Firefox `mozPressure` patch** | `console-guard.bun.test.js` | **behavioural** — the guard is run against a fake `MouseEvent` whose deprecated getters are enumerable, and the property's enumerability is checked afterwards (mutation-checked) |
| **The river names are OFF by default** (both layers) | `fao-rivers-layer.bun.test.js`, `river-layer.bun.test.js` | **behavioural** — the layer is loaded with an empty store (no names) and with the reader's stored choice (names) (mutation-checked) |
| **The upstream licence survives a rebuild** | `fao-rivers-layer.bun.test.js`, `data-licences.bun.test.js` | **the published DATA** — `meta.json` must carry the Exhibit B statement, and the builder must write it |
| **The name cleanups** (the mangled accents, the descriptions, the abbreviations) | `fao-rivers-layer.bun.test.js` | **the published DATA** — every published name is checked |
| **The satellite popup's mini map** | `interaction-prefs.bun.test.js` | **source** — `app.js` is 900 KB and cannot be sandboxed; the behavioural proof is the live Playwright run (the mini map builds, and the wrong popup no longer takes it) |
| **The API-down banner's X** | `offline-notice-dismiss.bun.test.js` | **source** — same reason; the behavioural proof is the live Playwright run of the whole dismissal cycle (X → gone → still gone 35 s later → forgotten on recovery → warns again) |
| **Every script carries a `?v=`** | `frontend-hygiene.bun.test.js` | **source** — the two rules that keep a year-long cache from freezing a file |

**THE RULE THIS FOLLOWS: A SOURCE TEST IS NOT A BEHAVIOUR TEST.** The
grep-style assertion answers *"is it wired?"*; only running the code
answers *"does it work?"*. Every change in this round that COULD be run
head-less now IS (the wind, the console guard, the two river layers);
the two that live in `app.js` are covered by source assertions **and**
by a Playwright run against the live site, because `app.js` cannot be
sandboxed honestly.

**WHAT IS STILL SOURCE-ONLY, AND WHY.** The satellite popup and the
API banner are both in `app.js`, which registers thirty-odd overlays and
creates a map at load time. Sandboxing it would mean a fake of the whole
site — a test that passes because the fake agrees with itself. The
house answer for that is the live audit (`scripts/offline_audit.py`,
`scripts/fao_rivers_audit.py`), which drives the **running site** in a
real browser. **Extracting either behaviour into its own module would
make it testable head-less** — that is a refactor, not a test, and it is
the honest next step if these two ever need unit coverage.

**MUTATION-CHECKED, WHERE IT MATTERS.** The three behavioural tests
added in this round were each verified by putting the OLD code back:
the fixed longitude window → *"nothing was drawn west of the
antimeridian"*; the console-guard patch removed → *"mozPressure" is
still enumerable*; the river-labels default back to "on" → *"a fresh
reader must see NO names"*. **A test that cannot fail is worse than no
test**, and these three can.

## System Health — Verified Status (2026-10-28)

Full-codebase review was completed 2026-09-26. See:
- **`docs/CODEBASE_REVIEW_2026-09-26.md`** — architecture, subsystem-by-subsystem findings
- **`docs/FIX_NOTES_2026-09-26.md`** — master actionable checklist + **fix-session status log**
- **`docs/SESSION_NOTES_2026-10-22-BAMAKO_PILEUP.md`** — the placement-pileup incident and its repair

### What changed in the last week (2026-10-21 → 2026-11-11)

| Area | Status | What it was |
|---|---|---|
| 🌬️ **`contain: paint` ON THE WIND PANE HID THE WIND — 51 fps, because nothing was drawn** | ✅ fixed (11-20) | Owner report: *“i dont see the wind working now?”* — and he was right: **the wind was invisible on every browser.** A compositing optimisation for the earlier *“the wind dots don't move around very fast”* report had put `contain: paint` on the wind pane. **THE FACT THAT DECIDED IT: EVERY LEAFLET PANE IS 0 × 0** — its children are absolutely positioned, so it has no intrinsic size — and paint containment clips painting to the padding box. **A 0 × 0 pane therefore clips its contents to NOTHING.** The original analysis had that fact in hand and drew the wrong conclusion from it: it rejected `contain: strict` *because* the pane would become 0 × 0 and *“the wind would vanish”*, without noticing the pane **already was** 0 × 0, so `paint` clipped it away exactly the same way — only the mechanism differed. **MEASURED, fps AND SCREEN PIXELS IN THE SAME RUN (Playwright, the owner's link, the wind pane hidden and re-shown to isolate its own pixels):** Firefox **51.3 fps / 58 wind px** as shipped against **24.5 fps / 34,954 px** with containment removed; Chromium **51.6 fps / 0 px** against **22.3 fps / 33,948 px**. **THE 51 fps WAS FAST BECAUSE NOTHING WAS BEING DRAWN** — the identical trap this file already records twice (a freshly-replaced canvas measured 37 fps *because the detached canvas was not being drawn at all*), and with the wind ACTUALLY VISIBLE containment bought **nothing at all: 14.4 fps against 14.7 fps**. **THE FIX: the line is gone**, and the measurement that killed it now lives in the source where the line used to be, so the next reader sees the pixel counts rather than a triumphant fps. **THE INSTRUMENT IT WAS MISSING IS NOW THERE**: `scripts/wind_perf_audit.py` — which produced the numbers that sold the invisible wind — had **no pixel check at all**; it now screenshots with the wind pane hidden and re-shown and **fails the run (exit 1) on a zero-pixel result**, so an fps gain that draws nothing cannot be published as a win again. **Note the trap inside the trap: `getImageData` cannot see this** — the canvas BACKING STORE keeps its ink while an ancestor clips it away, which is exactly how *“the canvas ink is unchanged”* coexisted with a wind nobody could see; only a SCREEN screenshot diff catches it. **AFTER, live, both engines:** `contain: none`, wind animating (**120,545 screen px changing over 1.8 s**), 1,234 particles, **144 tile images / 0 broken**, 0 console errors. Pinned by `public_html/tests/wind-paint-containment.bun.test.js` (**16 tests**, mutation-checked — re-adding the line fails them; the previous version of that file asserted the line *appears in the source*, i.e. a gate that passed against the broken code). Tests: **1873 pass / 0 fail** (107 files). Token `202611201930` via `bump_frontend.sh`. |
| 🧱 **A SHARED LINK'S OVERLAYS NEVER DREW — the staged-overlay queue was drained by one branch of one function, so any outcome but “pins came back” stranded every overlay** | ✅ fixed (11-20) | Owner report: *“if you load a page.. not all the tiles will load but if you wait like 2 min or 3 min finally the last tiles will all turn blue.. it kinda takes time and you maybe even have to pan around the map”* — with his nine-overlay link `#6.6537,-65.7202,6/…overlay=rivers@100,tectonic-faults-usgs@100,soil-soilgrids@20,cropland-esa@40,population-density-worldpop-1-km@20,koppen@20,rivers-fao-2026@90,wind-gfs@100,isobars@100…`. **THE STAGING ITSELF IS CORRECT AND STAYS** (the 11-12 row below: adding the overlays up front makes the main thread decode 280 tile images before the pin canvas draws — measured 20 s of empty map), **but the DEFERRED QUEUE HAD EXACTLY ONE DRAIN — the `items.length > 0` branch of `fetchPinsForViewport`.** Every other exit from that function dropped the queue on the floor: **the 25 s auto-abort firing while the NDJSON body was still streaming**, an HTTP 5xx, a network error, an exception, an **EMPTY result** (a sparse area is normal), a fetch **superseded** by a newer one (the stale `inflightCtrl` guard), and the **markers-off / content-layers-off early returns, which never reach the `try` at all.** A link that named nine overlays therefore drew the basemap and nothing else until some *later* fetch happened to succeed with pins — which is exactly why the owner had to pan. **MEASURED, THROTTLED (Regular 3G, Chromium, his URL): `/api/pins/map` answered 200, and 215 s later the overlay tiles had STILL never been requested — 28 basemap tiles, 0 overlay tiles.** **THE FIX:** the drain now lives in the fetch's **`finally`** — the one place every outcome settles — routed through an idempotent `scheduleDeferredOverlayFlush()` so the **two-frame markers-first ordering is preserved on the failing paths too**; the two early exits that never reach the `try` drain themselves; and `armOverlayFlushBackstop()` covers a boot where **no pin fetch ever runs**, waiting for a legitimate flush rather than racing it. **ITS 30 s CEILING IS SET BY THE FETCH'S OWN 25 s ABORT, NOT PICKED FROM THE AIR** — every fetch is guaranteed to settle (the abort still runs the `finally`), so a ceiling shorter than that would fire FIRST and hand the reader overlays decoded *ahead* of their markers, reintroducing through the safety net the very ordering the staging exists to prevent. **AFTER, SAME THROTTLE: flush at 18.5 s, 290 overlay tile requests, 196 tile images, 0 console errors**; the three deterministic failures (`/api/pins/map` **delayed 60 s / 500 / aborted**) went from **0 → 290** overlay requests each. **MARKERS STILL FIRST, MEASURED:** pins rendered → overlays released **+114 ms unthrottled, +72 ms throttled** (two frames). **Firefox:** map up, 196 tiles, **0 broken**, 0 errors. **`broken: 0`** on his URL — the 28 “pending” images a naive probe reports are the wind layer's `<canvas>` tiles, which have no `complete` property. **THE TRAP IN THE BACKSTOP, and it is worth keeping:** an earlier version used a 20 s ceiling, which is SHORTER than the fetch's 25 s abort — so it would have beaten the normal path and staged the overlays ahead of the markers on exactly the slow connection this bug was found on. Pinned by **`public_html/tests/deferred-overlays.bun.test.js` (**15 tests**, run against the pre-fix file as the mutation check: **11 of 15 fail there, 15 of 15 pass now**).** Tests: **1855 pass / 0 fail** (106 files). Token `202611200838` via `bump_frontend.sh`. |
| 🔐 **THE PASSWORDS HAD A GATE — SQL INJECTION AND ITS NEIGHBOURS DID NOT** | ✅ fixed (11-14) | Owner ask: *"do we have a test case that we use that regularly scans for passwords and security problems like sql and others?"* **THE PASSWORDS HAD A REAL GATE ALREADY** — the global git hooks (`/home/asher/.git-hooks/pre-commit` and `pre-push`, wired in through `core.hooksPath`, so every repo on this box) scan the staged and the PUSHED content for credential-shaped strings and personal paths, with this repo's `.secret-guard-ignore` as the allowlist, and `secretz --code` / `--gate staged` / `--gate tracked` does the same on demand. **That is why this repository can be public**, and both pushes made today went through the pre-push hook untouched. **THE OTHER HALF DID NOT EXIST.** The defences against SQL injection here are STRUCTURAL — postgres.js tagged templates, psycopg `%s` placeholders, a Zod schema on every route, `assertSafeUrl`/`safeFetch` on the routes that fetch a reader's URL — and **structural defences do not fail loudly when someone adds a fourth way in**. Nothing watched for a regression. **`scripts/security_check.py` IS THAT WATCH**: it walks the repository and fails on the patterns that make a hole — an interpolated query (`sql-interp-python`, `sql-unsafe-ts`, `sql-interp-ts`), an unguarded shell call (`shell-injection`), a request value joined into a path (`path-traversal`) — with the **XSS, SSRF and `sql.unsafe(variable)`** rules REPORT-only, because whether `${chips}` is safe is a **data-flow** question a regex cannot answer. **IT IS A RATCHET, NOT A WALL** (the rule `scripts/ci.sh` already follows): `scripts/security_baseline.txt` holds today's findings and the gate fails only on a NEW one. **TODAY THE BASELINE IS EMPTY — ZERO GATED FINDINGS.** The first thing it found was a real one: `scripts/system-status.sh` built a query with an f-string, and it was **FIXED** (`psycopg.sql.Identifier`), not baselined. **AND THE GATE WAS PROVED ABLE TO FAIL**: `tests/test_security_check.py` (8 tests) writes each dangerous pattern into a sandbox inside the repo and asserts the scanner finds it (and that a clean file finds nothing), and an `sql.unsafe(\`… ${tid}\`)` probe injected into `api/src/routes/analytics.ts` took **`bash scripts/ci.sh --only security` RED** and green again on restore. **ALONG THE WAY A PRE-EXISTING BUG IN `ci.sh` WAS FIXED**: the pattern that prints WHY a stage failed was `grep -E "(fail\)\|FAILED\|ERROR\|error TS"` — **an unterminated group**, so grep printed *"Unmatched ( or \("* and a red stage showed **no detail at all**. What it does NOT cover is **Q-N50**. |
| ⛅ **THE CHANGE MAP RE-FETCHED ITS 130 KB FIELD ON EVERY PAN** | ✅ fixed (11-14) | Found in the review of the `delta=` work. **THE DELTA FIELD IS THE WHOLE WORLD AND DOES NOT CHANGE WITH THE VIEWPORT** — only the CONTOURING does. But `refreshDelta()` fetched it again on every refresh, and it also left `state.loaded` null, so `loadedCovers()` could never short-circuit: **the delta path was the only one that always ran.** **MEASURED ON THE LIVE SITE: four pans of the change map cost FOUR extra fetches of the 130 KB field** (five field fetches for one map). **THE FIELD, ITS GRID, ITS METADATA AND THE COLOUR SCALE ARE NOW CACHED AGAINST THE WINDOW THEY BELONG TO** (`state.deltaField` / `deltaGrid` / `deltaData` / `deltaWin`), and **the box the lines were cut for is RECORDED** (`state.loaded = box`) — so a pan **re-contours from the cache**, the cheap part, instead of going back to the network for the expensive one. **AFTER: ONE field fetch for the whole session**, and the pans still redraw — **395 → 364 lines** as the viewport moved, with the fetch count unchanged. The contouring is the same code on the same field, so **the picture is the same**. A DIFFERENT WINDOW means a different field, and `deltaWin` is what tells them apart. Tests: **`isobar-delta-url.bun.test.js`** (the cache, the guard and the recorded box) and measured by **`scripts/isobar_delta_url_check.py`**, which pans the map and asserts the fetch count does not move. |
| 🎛️ **THE ✨ COOL MAPS CHIPS RAN OFF THE PANEL ON A PHONE — the last two or three were unreachable** | ✅ fixed (11-14) | Found while measuring the new satellite preset. **THE CHIPS ARE ONE FLEX LINE** (`.leaflet-presets-chips { display: flex }` with **no `flex-wrap`**), so their width is the **SUM** of the chips' widths — and the layers panel is **335 px** on a 393 px phone. **MEASURED: ten chips were 417 px, and the eleventh (🛰️ Satellite) made it 459 px** — the last chip's right edge sat at **435 px against a panel that ends at 353 px**, so the last two or three chips (🌌 Night lights, 🛰️ Satellite, 🌱 Climate skin) were **cut off and unreachable on a phone** without horizontal scrolling. (The defect was there before the eleventh chip; the eleventh made it 42 px worse.) **THE FIX IS ONE LINE**: `flex-wrap: wrap` puts the chips on a second line instead of running off, and `min-width: 0` lets the row shrink inside the flex parent that holds it. **After: the row is 330 px inside the 335 px panel, and all eleven chips are inside the panel AND hit-testable** (verified in a real browser at 393 px and 1440 px). Pinned by **`map-presets.bun.test.js`**. |
| 🛰️ **THE "CLEAR THE MAP" BUTTON WAS THE OWNER'S 15-OVERLAY MAP — "too slow on some computers" — and the LOW-RES tier was NOT satellite-only either** | ✅ fixed (11-14) | Owner ask: *"for the 'clearned map' i think we just need a sattiltie view.. https://xyzo.org/#19.9733,0.0000,2/density=max … its just too slow on some computers"*, and then: *"we also have some checks to see before loading the page if we should show a low rez version without any overlays except the satellite view correct.. thats already workin but we might need to test it"*. **THE 🛰️ BUTTON RESTORED THE OWNER'S OWN MAP** — satellite, the **wind animation** over the pressure lines (`#1.9771,36.1230,4/density=max/overlay=wind-gfs@100,isobars@100/iso=1:pressure/isoSrc=gfs/wind=particles:speed:100`) — and the wind animation is the most expensive thing on the page: **a canvas that repaints every frame over a field that has to be fetched and contoured first**. It is now the **satellite view**, the owner's own link verbatim: `#19.9733,0.0000,2/density=max` — the world, the satellite basemap, the pins at max, **no overlays at all**. **THE HASH NAMES NO `overlay=` SEGMENT, AND THAT IS THE POINT**: the hash-apply path only ADDS, but `applySavedStyle()` REMOVES every overlay the state does not contain first, so a hash with no overlays list is a hash that says "none" — **and a missing overlays list must NOT be normalised into `[]`**, because an empty array is also what a CORRUPTED state looks like, and `sanitizeState()` rejects that one so it can never reach `applyMapState()` and strip every overlay by accident. **AND THE "LOW REZ" MAP WAS NOT THE SATELLITE VIEW.** The tier check worked; the map it chose for a slow machine was the **"🌱 Climate skin"** — the Köppen wash plus the city names, and **the city names alone pull the 1.16 MB city index**, so the light map was not light. `COOL_ID.low` is **`"plain"`** now: a satellite-only preset at **`density=medium`** (the pins are the heaviest thing a slow machine fetches — 3,000 at max, 1,500 at medium), and the density is a **separate axis** from the overlays. **MEASURED LIVE by the new `scripts/default_map_check.py`** (Playwright, a real browser, a slow machine's `deviceMemory`/`hardwareConcurrency`/`saveData` stubbed before the page's scripts run): the showcase opens with **13 overlays · 250 requests · 4.7 MB**, the satellite view with **0 overlays · 130 requests · 2.6 MB**, and the 🛰️ button on the showcase leaves **0 overlays**, base **🛰️ Satellite**, zoom **2**, centre **(19.9733, 0)**, URL `#19.9733,0.0000,2/density=max` — **0 page errors**. Tests: **`default-map-button.bun.test.js`** (rewritten) and **`map-presets.bun.test.js`** (the tier and the light map). **THE THREE "CLEAR THE MAP" CONTROLS NOW OVERLAP, AND THEY DO NOT MEAN THE SAME THING — see Q-N49.** |
| 🔐 **75 FILES CARRIED THE DATABASE PASSWORDS IN PLAIN TEXT — and three files over 100 MB that GitHub REFUSES to accept** | ✅ fixed (11-14) | Publish-readiness scan ahead of **https://github.com/htmlfarmer/xyzo.org** (GPL-3.0). **`secretz --code` counted 109 critical / 27 warn on the file set git would push; it now reports 0 / 0 / 96 placeholders.** Five literal passwords were spread over **75 files** — the **app-password default** (72), the **cities-writer password** (6), the **legacy newsium password** (5), **the chosen PRODUCTION password (3: `HANDOFF.md`, `scripts/setup.sh`, `scripts/backup-lightweight.sh`)**, the **cities-reader password** (2) — in DSN URLs, `PGPASSWORD=…` prefixes, `ALTER ROLE … PASSWORD '…'` in a migration and a bootstrap SQL, and `DB_PASS=` in setup.sh. Every DSN is now an **env-var read with a `CHANGE_ME` default** (`os.environ.get(...)` / `${VAR:-…}`) and the systemd units carry a placeholder **plus `EnvironmentFile=-/etc/xyzo/xyzo.env`** — systemd is unambiguous about precedence (*"Settings from these files override settings made with Environment="*), and the live units are separate files under `/etc/systemd/system`, so no repo edit touched production. **THE PASSWORDS WERE NEVER REMOTELY EXPLOITABLE**: `listen_addresses = localhost` with `pg_hba` **`trust`** — a garbage password was accepted too. But that production password was a *chosen* value, not a placeholder, and it sat in 415 commits of history. **GITHUB WAS BLOCKED INDEPENDENTLY OF SECRETS**: `data/alternateNamesV2.txt` **744 MB**, its `.zip` **194 MB** and `data/nn_models/…/model.pt` **127 MB** all exceed GitHub's **100 MB hard limit per file** — **tracked payload 1.34 GB → 84.6 MB, no file over 25 MB**, by untracking them (all stay on disk) with `geoip/GeoLite2-City.mmdb` (62 MB — MaxMind's own data terms, fetched weekly by `scripts/update-geolite.sh`), `data/nn_models/`, `data/visual_baselines/`, `data/playwright_traces/`, **142 tracked `logs/` files** (one carried scraped third-party emails) and 5 `.deploy-backups/` tarballs. **`LICENSE` is now the full GPL-3.0 text**, the clone URL in this README pointed at a repo that does not exist (`xyzo-org/xyzo`), and `deploy/xyzo-story-link.service`'s `Documentation=` did too. **THE GATE IS GREEN AND STILL BITES**: `secretz --gate staged` ✓ and `--gate tracked` ✓, while a staged probe line carrying a real-looking DSN password is still **BLOCKED** with the value redacted — and it caught a bug in itself along the way (a `+`/`-` line asymmetry that made it reject the commit which *removes* a secret). Tests: **1824 pass / 0 fail** (104 files). See **"Publishing to GitHub"** below. |
| ⛅ **THE CHANGE MAP'S WINDOW WAS NOT IN THE URL — clicking "24 h" changed the map and left the address bar alone** | ✅ fixed (11-14) | Owner ask: *"can you make sure the url is updated when someone clicks on `<button type="button" class="soil-prop-btn is-active" data-delta="24h" title="The change in pressure over the change over the last day (2026-11-13 → 2026-11-14)" aria-pressed="true">24 h</button>`"* — the chip that switches the isobar layer from the ordinary pressure chart to the **Δp CHANGE map** (the difference between two archived analyses). **THE WINDOW LIVED ONLY IN localStorage** (`xyzo.isobarDelta`): the chip changed the map, the address bar did not move, and the **SHARE button copies `location.href` VERBATIM** — so a reader who switched to the change map and pressed Share handed over a link to the **ORDINARY chart**. It is the same defect the detail step (`iso=`), the line colour (`iso=…:red`) and the analysis (`isoSrc=`) had, and they all travel for the same reason: **the change map is a DIFFERENT PICTURE of the same atmosphere, not a different setting of the same picture.** **THE SEGMENT IS `delta=<window>`** (`delta=24h`), written **only when a window is chosen** — the ordinary chart is the default and there is exactly ONE way to spell it, so a segment that says "the default" can only add a way to be wrong (this is the ONE isobar segment that is *not* written always; the step has eight values, and the reader's own stored one would decide otherwise). It is **read back** and applied **BEFORE the layer is enabled** — the window decides WHAT the fetch asks for — and it is a **VIEW**: `persist: false`, so opening someone else's link never overwrites the reader's own stored window. **THE CHIP ROW IS REPAINTED FROM `setDeltaWindow()` ITSELF**, because a window can arrive with no click at all (a link, a saved style) and a chip row that says "pressure" while the map draws the change map is a control lying about what is on screen. **AND A PASTED LINK NOW APPLIES THE LAYER'S SETTINGS TOO** — a pasted link is a **SAME-DOCUMENT navigation**, so the boot-time restore never runs and the `hashchange` handler is the only thing that can apply it; it enabled the isobar layer but never its settings, so pasting `/iso=0.25:red/delta=24h` into an open tab promised a picture the map was not drawing. **MEASURED LIVE by the new `scripts/isobar_delta_url_check.py`** (Playwright, the live site): the click moves the URL to `…/isoSrc=auto/delta=24h`; switching back to "pressure" **drops** the segment; a **cold** link opens on the change map with the chip active while the reader's own stored window ("7d") **survives**; and a link **pasted into an open tab** applies it too. Tests: **`public_html/tests/isobar-delta-url.bun.test.js` (15)**. |
| 🌐 **Two units were RED in `logz` — and the earthquake one meant the overlay had quietly stopped publishing for three days** | ✅ fixed (11-14) | Owner pasted a `logz` scan: **`xyzo-earthquakes.service` FAILED (exit-code, 13:04:58)** — `verify() failed — refusing to publish` — and **`xyzo-ocean-currents.service` FAILED** with `urllib.error.HTTPError: HTTP Error 404`. **EARTHQUAKES: THE GATE WAS DOING ITS JOB AND THE BOX WAS WRONG.** The axis check (§5 of `verify()`, `PLACE_PROBES`) measured **`13.3 % of the 30 Chile events fall outside Chile's box (-41.0..-17.0 lat, -70.0 +/- 7.0 lon)`** against `PLACE_PROBE_TOLERANCE = 0.05` — so **229 VERIFY FAILs across a 3-day journal window at a 10-minute cadence**, and the published files froze at their **last success, 2026-11-11 11:34**: three days of a stale overlay, with nothing on the map saying so (the layer serves *our* files, so it drew the old catalogue happily). **MEASURED AGAINST THE LIVE FEED (9,933 month events) — the four offenders are not axis errors:** `(-41.55, -74.21) "48 km NW of Ancud, Chile"` — Chiloé, and **Chile itself runs to 56°S**, so the old southern edge cut the country in half — plus **three "West Chile Rise" events at lon -97.96 / -97.98 / -87.60**: USGS names the Chile Rise spreading centre after Chile, ~3,000 km offshore. **THE MATCHER IS BY NAME** (`name in place`), so the box has to cover what the name covers; a box spanning only the Peru-Chile trench was always going to fire on a real catalogue, it just needed a swarm to reach it. The box is **(-56..-17 lat, -70 ±35 lon)** now. **THIS IS A WRONG BOX BEING CORRECTED, NOT A GATE BEING LOOSENED**: `PLACE_PROBE_TOLERANCE` is untouched at 0.05, the other ten probes are unchanged (measured 0.0–0.7 % outside), and **the axis test still bites** — a swapped coordinate puts the longitude in the latitude (-63..-98 as a latitude, against a box that stops at -56) and the mirrored longitude is >100° off -70, so a swap still puts 100 % outside. Re-run: **`python3 scripts/earthquake_build.py` → `verify() passed: {'hour': 7, 'day': 189, 'week': 1947, 'month': 9933}, 11/11 place probes`**, all five files rewritten 13:20. **THE OCEAN UNIT IS STILL RED, AND THAT IS CORRECT**: its freshness gate refuses a composite the ERDDAP mirror dates to 2014 (**4,431 days old**, limit 45) and exits non-zero *on purpose* so the timer alarms daily until a fresh source exists (Q-N1). What changed there is only the *reading*: a 404 from the upstream listing used to print **five frames of urllib traceback** as the whole of the failure, and `main()` now catches it and logs **one line with the URL and the status** — `build failed: the upstream answered HTTP 404 for …/jplOscar/ — the published grid is unchanged` — while the exit stays **1**, because a build that did not refresh must still show in `systemctl --failed`. Verified by pointing the listing at a 404 path: one line, `return 1`, no traceback. Pinned by `public_html/tests/earthquake-layer.bun.test.js`, whose control drives the real `verify()` with a synthetic catalogue (a good one accepted, **the same one with swapped axes refused**) — it passes, so the widened box did not weaken the gate. |
| 🖥️ **Two console lines from the owner — a service worker blamed for the network, and Firefox's `zoom` warning** | 🔎 diagnosed (11-14) | Owner pasted two console messages: `Failed to load '…/api/pins/map?bbox=…&limit=2000…'. A ServiceWorker intercepted the request and encountered an unexpected error. sw.js:491:11`, and `This page uses the non standard property "zoom".`. **THE FIRST IS A NETWORK FAILURE SEEN THROUGH THE WORKER, AND THE WORDING IS THE DIAGNOSIS** — a new gate (`scripts/sw_console_audit.py`, Playwright/Firefox, the shipped `sw.js` on a local origin we control) shows Firefox uses **two sentences at that one line**: *"passed an Error Response … invalid fetch() call"* = the request **never completed**; *"intercepted … unexpected error"* (the reported one) = **the response started and its body died mid-transfer** — reproduced with headers promising 100,000 bytes and 5,000 delivered, which is their **630 KB** `limit=2000` answer cut short. Both give the page a `TypeError` and the page's own retry + banner takes over; **the worker was never broken and the second case cannot be fixed from inside `sw.js`** (the body fails after `respondWith` resolved, and buffering would kill the progressive NDJSON stream). What WAS added: `networkFirst(…).catch(() => networkError())` at the call site, so a rejection can never escape `respondWith` — it changes the console, not the contract. **THE MEASUREMENT'S OWN TRAP (four void runs): `navigator.serviceWorker.controller` truthy does NOT mean the next `fetch()` is intercepted** — `wait_for_function` said `active + controlling` and the next request still went straight to the origin — so the audit proves interception first (a probe path only the worker can answer) and polls until it engages. **THE SECOND LINE COMES FROM ONE DECLARATION**, `styles.css:8467` (`zoom: var(--ui-zoom)`, the A/A+/A++ text-size control): it is a *warning*, the property works (measured in Firefox 153: 151.2 px → 226.8 px at `zoom: 1.5`), **CSS warnings cannot be suppressed from JavaScript** (`console-guard.js` only intercepts `console.*`), and `zoom` is layout-affecting where `transform: scale()` is not — which the whole control is built on. **Not fixed; recorded as Q-N42/Q-N43.** Tests after the changes: **1809 pass / 0 fail** (103 files), `node --check public_html/sw.js` clean. |
| 🍃 **"THE WIND DOTS DON'T MOVE AROUND VERY FAST ON FIREFOX" — two defects inside the animation, one cost no page can fix, and the telemetry to see whose browser is which** | ✅ fixed (11-14) | Owner report, on the fifteen-overlay link `#2.1089,16.8750,3/…/wind=particles:speed:100`: *"lets do some extensive testing and figure out why the wind dots dont move around very fast on firefox… what we can do to speed this up for all users… or give some speed tips or options for example less wind dots or controllable number? also we need someone on the server side to help us understand how slow or how fast various situations are running on various peoples browsers so we can log them"*. **MEASURED, with a new tool (`scripts/wind_perf_audit.py`: Firefox + Chromium, fresh contexts, a density sweep, a wind-off control, and the dots' own speed as the MEDIAN displacement of the live pool):** before, **firefox 3.7–8.8 fps with the dots covering 15.6–37.4 px/s** (chromium 3.6–6.0 fps, 13.3–24.1 px/s) against a harness that reads **60.4 fps on a trivial page** — so the harness was not the problem. **THREE DEFECTS.** **(1) `step()` capped dt at 0.1 s**, which is a SPEED LIMIT below 10 fps: every frame threw away the rest of a tenth-second, so the field ran at `min(1, 0.1/dt)` of real time — the model predicts 37/31/40 px/s at the measured 8.2/6.9/8.8 fps and the tool measured 34.2/29.8/37.4, i.e. **the crawl was exactly the cap**. It is **0.25 s** now: real-time pace down to 4 fps, and a genuine stall still bounded to a ~17 px step rather than a slash across the map. **(2) THE PARTICLES WERE DRAWN WITH TWO WIDE ROUND-CAPPED STROKES** per speed bucket — instrumenting the live page showed `stroke()` was **80 % of every frame the wind spent inside canvas calls** (21.1 / 21.2 ms a frame). They are **three concentric FILLS** now (halo disc → bloom disc → core disc, the same annuli the strokes drew): **24.2 / 24.6 → 13.4 / 15.7 ms a frame**, zero `stroke()` calls, and the picture is unchanged — **mean |Δ| 0.54/255, 0.63 % of pixels differing by more than 24 levels, ink coverage within 1.1 %** (measured by drawing the same 900 dots both ways in Firefox). **(3) The Flow style advanced its fibres PER FRAME**, so at low fps it crawled AND a fibre lived four times longer in wall-clock; both the step and the age are dt-scaled now. **AFTER, same tool: the dots cover 38.0–47.9 px/s in EVERY run (3/3 interleaved pairs, before 29.8–37.4), the layer's canvas time is ~40 % lower, and one run reported 20.2 fps with zero frames over 100 ms.** **WHAT IS *NOT* FIXED, AND WAS MEASURED SO IT IS NOT GUESSED AT: THE OVERLAY STACK.** The frame cost grows ~**17 ms per overlay layer** (1 overlay 50 ms → 4 → 100 → 8 → 183 → 12 → 234) and hiding the other 35 Leaflet panes takes **267 → 50 ms** — it is the compositor re-stacking a deep pile of full-screen layers every time one animated layer goes dirty, which is free on a GPU and is the whole frame budget on software rendering. **Three CSS candidates were tested and all rejected**: `will-change: transform` and `translate3d(0,0,0)` changed nothing, and `contain: paint` "improved" 3.7 → 23.8 fps **only because all 36 Leaflet panes are 0×0**, so it clipped the entire map blank (mean luminance 125 → 214) — a speedup that draws nothing (Q-N39). **THE SPEED TIP IS ON THE PANEL NOW**: the legend prints the live frame rate beside the count (**"1,234 dots · 6 fps"**) and, below 30 fps, **"Slow here — turn overlays off or lower the density for smoother motion"** — the density control itself (25–400 %, slider + number box, carried in `wind=`) shipped 11-10. **AND THE SERVER CAN NOW SEE IT**: `client_perf` (migration `2026-11-14-client-perf.sql`) + `POST/GET /api/analytics/perf` + `public_html/perf-report.js` — **two rows per session per day** (`settled` 12 s after the map appears, `wind` 12 s after the animation starts) carrying frame cadence, long tasks, the **GPU/renderer string** (llvmpipe = every pixel painted by the CPU), a fixed-shape canvas benchmark, the overlay count, the wind's own counts and the dots' px/s, grouped by browser / device / renderer / overlay-count / wind-on. **Privacy: the UA is parsed to two short strings ("Firefox/153", "Linux") before it is sent, no IP is stored, the hash is truncated, and `retention_prune.py` drops it at 90 days.** **Traps found:** a fresh Playwright **Firefox profile stalls on its FIRST navigation** (`goto` never commits in 60 s — DoH/TRR warm-up; `network.trr.mode = 5` → 0.7 s); `WindLayer._state` is a **property**, not a function; and a backtick inside a SQL comment **terminates the JS template literal**. Tests: **`wind-slow-devices.bun.test.js` (12, new)**, **`perf-report.bun.test.js` (16, new)**, **`api/tests/client-perf.test.ts` (11, new)**, plus `wind-styles.bun.test.js` updated (the halo assertion now accepts either verb — the invariant is *"a dark halo is painted"*, not *"stroked"*). |
| 🌬️ **THE WIND WAS SLOW ONLY WHEN OTHER OVERLAYS WERE ON — and the cause was COMPOSITING, not drawing** | ✅ fixed (11-20) | Owner report (2026-11-14): *"the wind dots don't move around very fast on Firefox"*. The 11-14 session fixed three things INSIDE the animation (the 0.1 s dt cap, the per-frame fibre step, the stroked particles) and recorded that *"the frame cost grows ~17 ms per overlay layer … it is the compositor re-stacking a deep pile of full-screen layers every time one animated layer goes dirty"* — **as a KNOWN ISSUE, not a fix.** It WAS the fix's own reading, and it was right: the remaining cost was never the wind's drawing. **MEASURED (Playwright, the owner's own 14-overlay link, the particle count PINNED so the numbers were comparable — 3 runs each, medians):** **bare map + wind 32.3 fps · 14 overlays + wind 9.0 fps · 14 overlays with NO wind 58.8 fps.** The stack alone is fine; the wind alone is fine; TOGETHER they are 3.5× slower. **WHAT IS NOT THE CAUSE, MEASURED AND RULED OUT:** the wind's own JavaScript (CDP `ScriptDuration` ~1 s out of 7 s, **ZERO long tasks**); the **particle count** (3,086 dots → 772 changed the frame rate by **nothing**: 11.2 → 9.4 fps); the canvas's **size** (shrinking the backing store 16×, 1440×900 → 360×225, changed nothing); the number of `fill()` calls (dropping 2 of the 3 concentric discs per bucket: nothing); and **GPU promotion** (`will-change: transform`, `translateZ(0)`, `isolation: isolate`, `desynchronized` — all measured at 9.0 → 9.6 fps, i.e. **nothing**). **THE CAUSE:** the wind canvas is a full-screen canvas written to EVERY frame, and every write **INVALIDATES the surface it lives in**, so the browser re-composites everything painted under it — **15,958 Leaflet layers, 16,966,976 canvas pixels (13× the viewport), 2,042 SVG paths and 272 images — every frame.** The pin canvas (`overlayPane`, z=400) sits directly ABOVE the wind pane (379), so every wind frame re-uploads it too. **THE FIX IS ONE CSS DECLARATION: `contain: paint` on the wind pane**, which makes it a **paint containment boundary** — the browser paints the wind into a separate surface instead of invalidating the one the overlays share. **MEASURED AFTER, same audit, same link: firefox density 100: 12.2 → 45.6 fps; density 50: 13.2 → 59.7 fps; density 25: 13.2 → 60.0 fps (a vsync lock); chromium density 100: 6.5 → 34.4 fps.** And the **adaptive quality guard started working again** — Firefox's `qscale` rose from 0.4 (which was shedding a third of the dots **for nothing**) to 1.0, so the wind is **THICKER as well as faster**. **THE TRAPS, ALL MEASURED, ALL RECORDED IN THE SOURCE NEXT TO THE FIX:** **`contain: strict` is WRONG** — it implies `size` containment, the pane sizes itself to its contents (**0×0**, because its children are absolutely positioned) and **the wind VANISHES**; it measured a 4× speedup while drawing nothing. **`contain: paint` on the CANVAS does nothing** (9.0 → 8.3 fps) — it has to be on the PANE. **DIRTY-RECT CLEARING CANNOT WORK HERE**, and the reason is worth keeping: the wind field is **DENSE** (one dot per 420 px²), so the union of a thousand scattered 3 px rects is the whole screen — measured `dirtyFrac = 0.957`, i.e. the union was always the full canvas, so the code fell back to the full clear and nothing improved. **THE MEASUREMENT TRAP THAT NEARLY SOLD A FAKE FIX:** replacing the canvas element with a fresh one measured **37 fps** — because the **detached canvas was not being drawn at all**. Every candidate fix was therefore re-measured with the canvas's OWN INK read back (`getImageData`), so a "fast" wind that draws nothing cannot pass. Tests: **`wind-paint-containment.bun.test.js` (8, new, mutation-checked — reverting `contain: paint` fails 5 of them)**, suite **1865 pass / 0 fail**. |
| 🌊 **281 NAMED INTERNAL BASINS — the publisher's own `TO_BAS = -888`, not a name heuristic** | ✅ shipped (11-21) | Owner ask: *"can we start to support the INTERNAL BASINS we kinda need them"* — after the session found that the 8 endorheic regions we already showed were **all the name heuristic could ever find**. **THE DATA WAS THERE ALL ALONG, IN A DIFFERENT FILE.** Our source (FAO 2012, `bas_wrld_38047`) carries only `NAME_BASIN / GRID_CODE / AREA / PERIMETER` — **no hydrology column at all** — so the builder had to read the character off the basin's NAME (`"Interior"` → endorheic) and could only ever match the 8 regions FAO named that way. The FAO's **2022 "Hydrological basins of the world"** carries the sub-basin table the 2012 file lacks (`MAJ_BAS / MAJ_NAME / MAJ_AREA / SUB_BAS / SUB_NAME / SUB_AREA / **TO_BAS**`), and **`TO_BAS` is the downstream basin code: `-888` = internal sub-basin, `-999` = drains to the sea** — the PUBLISHER'S OWN definition, not one we infer. **Measured: 7,841 sub-basins, 281 with `TO_BAS = -888`**, each with a name and an area — Sahara (2.44 M km²), Borkou, Libyan & Egyptian deserts, Aral Sea, Lake Balkash, Ch'ing-hai Hu, Lop Nur, Gobi, Kyzylkum, Great Salt Lake, Lake Frome, Omuramba Ovambo … against the 8 coarse regions the name rule found. **FOUR LEVELS, TWO POPULATIONS × TWO PRECISIONS** — `major` (235 @ 0.05°, 6.1 MB) · `detailed` (235 @ 0.01°, 12.8 MB) · **`internal` (281 @ 0.05°, 0.3 MB)** · **`internal-detailed` (281 @ 0.01°, 1.6 MB)** — as four chips in the same dropdown row, so *how much detail* and *which population* are one control. **MEASURED IN THE BROWSER (Playwright, live site):** `internal` renders **1,933** drawn vertices at smoothFactor 1, `internal-detailed` renders **19,170** at smoothFactor 0 — **9.9× more geometry**, and at the Makgadikgadi pan (z7) **88 → 496 vertices (5.6×)**, with the detailed outline tracing the actual salt-pan edge on the satellite imagery where the coarse one is straight-line segments. **THE `smoothFactor` RULE HAD TO STOP PATTERN-MATCHING THE LEVEL ID.** It was `state.level === "detailed" ? 0 : 1.0` — which gave the **WRONG answer for `internal-detailed`** and would have shipped that level as the exact no-op the rule exists to prevent, in the one level added after the rule was written. It now reads the level's own **`simplify_deg` from meta.json** (`tol <= 0.01 → 0`); the tolerance is the fact, the id is only its name. **THE LEGEND NOW DESCRIBES THE LEVEL THAT IS ON SCREEN.** It printed the top-level `basin_count` (235) and all three kind rows whatever was selected — so the internal level would have been introduced by a key saying *"235 FAO basins"* over a list offering river and coastal basins that were not on the map at all. It prints the active level's own count (**"281 FAO basins"**) and only the kinds that level actually has (**"Interior (endorheic) basin (281)"** — one row). **A LICENCE OBLIGATION WAS CLOSED ON THE WAY.** `docs/DATA_LICENSES.md` had logged as **OPEN** that the upstream **HydroSHEDS v1** terms require the **Exhibit B attribution to travel with the layer's METADATA** — the FAO credit was present, the WWF statement and the 2008 citation were not. Publishing a second HydroSHEDS-derived source made it indefensible, so all three strings are now written **by the builder itself** into `meta.json` (a text that lives only in a doc disappears on the next rebuild — the exact failure `river_network_build.py` records). Tests: **`basin-detail-level.bun.test.js` (17, new)** and `basin-layer.bun.test.js` (the population rule rewritten), suite **1880 pass / 0 fail**. |
| 🌊 **THE BASIN "DETAILED" BUTTON WAS A NO-OP — Leaflet threw away 98.7 % of the detailed file before the reader saw it** | ✅ fixed (11-20) | Owner report (2026-11-20), on the link `#-23.2817,20.4785,4/density=max/overlay=rivers@100,soil-soilgrids@20,cropland-esa@40,population-density-worldpop-1-km@20,koppen@20,rivers-fao-2026@90,wind-gfs@100,basins@100/…`: *"i dont see it working… shows the same map as major basin right?"* — **and the owner was right.** **MEASURED IN THE BROWSER (Playwright, the real page):** the DETAILED file really IS finer — **689,947 vertices against the major file's 324,123** (read from the published GeoJSON) — and the switch really DOES fetch it (the browser requests `basins_detailed.geojson` and receives 235 features / 689,947 vertices). **And yet the RENDERED result was byte-for-byte IDENTICAL to the major level: all 235 paths had exactly the same `d` attribute length** (121,217 → 123,306 — a 1.7 % difference that is the features' own outlines, not extra detail), and only **9,207** of the 689,947 vertices ever reached the screen. **THE CAUSE: Leaflet simplifies every polyline and polygon with a tolerance of `smoothFactor` PIXELS** (its default is **1.0**), and it reads that option when the polygon is **CREATED**. So the client discarded the extra precision before the reader ever saw it — the level switch was a NO-OP, and the two published files differed only on disk. **THE FIX:** `smoothFactor: 0` for the detailed level, so the published file's own precision (**0.01° ≈ 1.1 km**) is what is drawn. The **MAJOR level keeps Leaflet's default (1.0)**, so the fast map stays fast and still carries one screen pixel of error — the detailed file is 12.8 MB against the major file's 6.1 MB and draws 7.3× the vertices, and that cost is the point of the switch. The factor is set on **the layer AND on every feature** (Leaflet reads it at creation, and `setStyle` does NOT re-simplify), and `setLevel()` updates it **before** `fillLayer()` re-adds the polygons — a switch that only swapped the data would keep the old tolerance and reproduce the bug exactly. **AFTER, measured: 8,972 → 65,782 drawn vertices (7.3×), total path length 121,217 → 629,126 (5.2×), individual basins 2.4×–10.6× sharper**, and switching back to major restores the original exactly. **THE INTERNAL (ENDORHEIC) BASINS WERE NEVER MISSING** — the owner's second question (*"i'm very sure there is … new INTERNAL water basins"*) was also right: the published data has **8** of them, each in its own colour (`#a78bfa`, against the cyan river and coast basins) and its own legend row, and **"Africa, South Interior" sits 552 km from the owner's own view** (the Makgadikgadi/Okavango pans of Botswana — confirmed on screen, purple outline over the Kalahari). FAO's own documentation names them (*"TO_BAS — downstream sub-basin code, **-888 internal sub-basins** and -999 draining to the sea"*), though the 2012 shapefile we publish carries only `NAME_BASIN/GRID_CODE/AREA/PERIMETER`, so the kind is read off the FAO's own naming (*"Interior"*) by the builder. **THE MEASUREMENT TRAP:** the first click test looked for `[data-basin-level="detailed"]` while the button is `[data-level]` — and a *second* early reading of "37 fps" for the wind came from a **detached canvas that was not drawing at all**, so every candidate fix was re-measured with the ink read back. Tests: **`basin-detail-level.bun.test.js` (10, new, mutation-checked)**, suite **1865 pass / 0 fail**. |
| 🛰️ **"AN EASY WAY TO CLEAR THE MAP" — and the live feed's "AI Suggested" tab was SQUEEZED and NEVER LOADED** | ✅ shipped (11-13) | Three owner asks: *"can you have a easy way to 'clear the map to a default satellite only view' maybe down near [the ⚙]"* — then, with a map of their own, *"maybe this default map is wiser?"*; *"also dont show the 'how to' on the first load thats kinda annoying.. just put that with something else"*; *"when the live feed pops up.. the Ai suggested isn't really showing correctly its all smooshed.. playwrite?"* **THREE THINGS, THREE MEASUREMENTS.** (1) **THE 🛰️ BUTTON** sits in the bottom bar beside the ⚙ and restores the owner's **own** map — `#1.9771,36.1230,4/density=max/overlay=wind-gfs@100,isobars@100/iso=1:pressure/isoSrc=gfs/wind=particles:speed:100`, **their hash, verbatim** (satellite, the wind over it, the pressure lines at 1 hPa off GFS under it, the pin density at max). **SUPERSEDED 2026-11-14 — see the row at the top of this table: the button is the SATELLITE view again** (the wind animation over the pressure lines was *"too slow on some computers"*). **IT IS A HASH, LIKE EVERY OTHER VIEW ON THIS SITE**: `map-presets.js`'s `DEFAULT_MAP` → the same `parseHash()` a preset and a shared link use → the same `applyMapState()` → `applySavedStyle()` → `applyLayersFromParsedHash()` chain — a button that assembled the map by hand would be a second implementation of "what a map is", and the second implementation is the one that drifts. **THE BAR HAS NO ROOM ON A PHONE, MEASURED**: the language switcher takes **157 px** and each button is **44 px** (the WCAG floor), so the bar's content is **397 px in a 377 px bar** and the **⚙ — the LAST item — hangs 29 px off the right edge**, taking the whole control menu with it. The bar button is **hidden below 560 px** and the same action is in **⚙ → MAP → "🛰️ Default map"**. (2) **THE TOUR NO LONGER SHOWS ITSELF** — it used to appear 1.8 s after the boot, and on a phone the card is a sheet covering most of the screen, so the reader's first sight of the site was a modal card about a map they had not looked at yet. **A tour nobody asked for is a tour that is closed unread.** The two buttons (⚙ → TOOLS → "How to", the help panel) are the whole way in, and they still work. (3) **THE "AI SUGGESTED" TAB HAD TWO DEFECTS, AND THE SECOND ONE WAS THE WORSE.** The strip was **one flex row**: five tabs in a 320 px panel gave each **~58 px**, so **"🤖 AI Suggested" broke into FOUR lines** and the strip **overflowed the panel by 14 px** (measured: 300 px of content in a 285.8 px box) — it is a **GRID** now, two columns, the longest label on the whole last row, one line each. And the tab **never loaded**: it asked the pins list endpoint for `min_confidence=0.85` with **no time window**, and that query's articles leg has no time predicate — so the plan was a **sequential scan of the 17 GB `news_articles` table**: **MEASURED, the query was still running after THIRTEEN MINUTES** (four copies of it, each reading 17 GB) and the tab said "Loading AI Suggestions…" the whole time. It is **windowed now** — the panel's own filter, capped at three days, and "all time" capped too — and it asks the **map** endpoint, the site's hot path, which also carries the **place, the country and the image** so a card says *where* the story is: **1.7–3.4 s cold**, 0.2 s warm. **THE ARITHMETIC IS THE POINT**: a window is `[since, now]`, so a shorter window has the **later** start — the first version took the earlier one and made the cap **widen** the window. Two more honesty fixes in the same tab: the badge was `confidence_score \|\| 0.9`, so a story the server had said **nothing** about was shown as **"🤖 90 % Match"** (a number the server never sent), and the failure path fell back to the feed's hot list — **a different answer under the same tab name**. Gate: **`scripts/live_panel_audit.py`** (Playwright, the shipped page, on a desktop, a **393×852 phone** and at the **largest text size**) — the tour does not open itself, ⚙ → "How to" still does, every tab label is on one line, the strip does not overflow, every bottom-bar button is on screen and tappable, the AI tab shows cards that say where they are, and the 🛰️ button puts the owner's map on the screen. Tests: **`default-map-button.bun.test.js` (11)**, **`live-panel-tabs.bun.test.js` (11)**, **`tour.bun.test.js` (20, rewritten)**. |
| 🎯 **"RATHER THEN AUTOZOOMING IN ON A PIN THATS IN A CITY... GIVE PEOPLE THE OPTION AFTER THE POPUP OPENS"** | ✅ done (11-13) | Owner ask: *"rather then autozooming in on a pin thats in a city we need to give people the option after the popup opens to zoom in someplace in the popup after they click on the news pin."* **WHAT IT WAS:** clicking a pin called `maybeZoomToCluster()`, which flew the map to a city-level view of the pin's neighbours **unasked** — the reader's view of the world was taken away from them by a pin they had merely tapped, and the popup opened into the middle of that 700 ms flight. **WHAT IT IS NOW:** the click opens the popup **where the reader already is** — the map does not move — and the popup's action row carries a **🔎 "Zoom the map to this place"** button beside the coordinates and the satellite button. **THE BUTTON ALWAYS DOES SOMETHING:** with three or more stories nearby it shows the cluster (the view the auto-zoom used to give unasked), and with an isolated pin it shows the place itself at city level — and it never zooms **out**. Measured live: click a pin → zoom **9 → 9** (no move ✓) → click 🔎 → zoom **9 → 11** ✓. **THE BUTTON IS IN THE ACTION ROW, NOT BELOW THE FOLD** — the popup's content is ~914 px in a ~380 px box, so a control lower down is invisible AND un-hittable (clipped content is not hit-tested). **THE OVERFLOW BADGE STILL FLIES TO ITS CLUSTER** — it is a cluster badge ("43 stories here"), not a story pin. Tests: **`public_html/tests/popup-zoom-to-place.bun.test.js` (6)**. |
| 💥 **"CONNECTION hiccup — showing cached data" + `Set map center and zoom first.` — a regression of this session's own, caught by the OWNER** | ✅ fixed (11-12) | The owner pasted a live failure: the map showed **"📡 Connection hiccup — cached 1h ago — Brief network issue — showing cached data"** and the diagnostics panel carried **`{"kind":"exception","errorMessage":"Set map center and zoom first."}`** on **Firefox 157**. **THE CAUSE WAS THIS SESSION'S OWN CHANGE.** To stop the browser asking for 16 world tiles the map was created with the link's view in the CONSTRUCTOR — but **Leaflet 1.9.4 has NO `setView`/`center`/`zoom` constructor option** (grep the vendored file: `options.setView` — zero hits), so the option was **silently ignored** and the map was left with **NO VIEW AT ALL**. Every accessor then throws (`_checkIfLoaded` → *"Set map center and zoom first."*), so the **first pin fetch** — the one that asks the map for its bounds — died, and the reader got a failure notice instead of markers. A second bug of mine compounded it: the boot view was built as an **array** and read with `.lat` (undefined on an array), so the map was told `setView([undefined, undefined], undefined)` → *"Invalid LatLng object"* → **which killed the rest of app.js**, including the fix that gives the container its height on Firefox. **THE LESSON IS THE IMPORTANT PART: THE FIRST VERSION OF THE TEST PASSED AGAINST THE BROKEN CODE** — it asserted the SOURCE SHAPE, and the shape matched. **A GATE THAT PASSES AGAINST BROKEN CODE IS NOT A GATE**, so the real gate is now BEHAVIOURAL: **`scripts/first_load_audit.py`** drives the shipped page in **Firefox AND Chromium** and asserts no page errors, that the map HAS a view, that the markers arrive, that the container has a height, that the link's overlays are on, and that **the stale-data notice is NOT showing**. **AND THE NOTICE NOW TELLS THE TRUTH**: an exception is a bug in the page, not a network problem, so it says **"Map problem"** instead of "Connection hiccup — will retry automatically" (a lie: a retry cannot fix a crash). Tests: **`public_html/tests/first-load-speed.bun.test.js` (12)** + **`scripts/first_load_audit.py` (both browsers)**. |
| 🐢 **"IT TAKES 30 TO 45 SECONDS" — the MARKERS were waiting for the browser to decode 280 tile images** | ✅ fixed (11-12) | Owner report: *"markers seem to be taking a long time to load... it took more then a few min when my friend tried to load"* [the 15-overlay URL], then *"seems to take about 30 to 45 seconds... are you sure.???"*. **THE FIRST MEASUREMENT WAS WRONG AND THE OWNER WAS RIGHT.** It said "6.8 s" because it measured (a) the FIRST markers, not the finished page, (b) on THIS box over the loopback, and (c) the resource timing while the heavy responses were still in flight. **THE TRUTH, MEASURED ON A THROTTLED SLOW-3G LINK: the pins ARRIVE at t=10.6 s and the markers are PAINTED at t=30.5 s — a TWENTY-SECOND GAP.** The network was not the cause: the main thread was busy decoding and painting the **280 tile images of the eight raster overlays** the link asked for, and the pin canvas drew after all of them. **THREE FIXES, EACH MEASURED:** **① THE INITIAL VIEW IS THE LINK'S VIEW** — the map used to be created at the world view (z2) and moved to the hash's view a moment later, so the browser asked for **16 world tiles it threw away** and they competed with app.js for bandwidth; the hash is now parsed BEFORE the map exists and the view goes in as the constructor's own view. **② THE CITY INDEX IS NOT ON THE CRITICAL PATH** — a `<link rel="preload">` in the HEAD does **not** wait for idle (the browser starts it as soon as it parses the HTML): the 1.16 MB city index was the **FIRST request on the page (t=0.30 s, before app.js)** and stole the bandwidth app.js was waiting for — and the markers cannot start until app.js lands; the preload is gone and the index is fetched when the reader touches the search box or the map. **③ THE OVERLAYS ARE STAGED** — the basemap and the MARKERS come first, the overlays are added a frame later (which is what every map does anyway); the total time to "everything" is the same, the time to a USABLE MAP is twenty seconds shorter. **AFTER: the markers paint at 12.4 s (3G), 4.2 s (4G) and 2.9 s (loopback) — against 30.5 s, 9.0 s and 11.5 s before.** Tests: **`public_html/tests/first-load-speed.bun.test.js` (9)**. |
| ⚡ **THE PRE-INDEX MISSED MOST READERS — the limit was part of the key, and the "all time" window was never built** | ✅ fixed (11-12) | The pre-index was built for `limit=1000` and the `24h` window ONLY, while the key is `query \| window \| tag \| limit` — so a reader asking for 100 or 250 pins of the same query **MISSED** and paid the whole live query (measured **1.07 s** for 250 pins of a query whose answer was already on disk). And the site's **"all time"** filter (the window a reader picks when they want everything — the expensive one, the whole corpus) was **never built at all**, because the timer passed `--window 24h`. **A SMALLER LIMIT IS NOW SERVED BY SLICING A BIGGER STORED ANSWER** — the stored answer is the RANKED list and the ranking does not depend on the limit, so the first N of a 1,000-pin answer is exactly what the live query would have answered for N; the pagination (`has_more`, `next_cursor`) is recomputed from the last row kept. **THE TIMER NOW BUILDS BOTH WINDOWS** (`--window 24h --window all`). Measured after: `limit=1000 → 0.26 s`, `250 → 0.21 s`, `100 → 0.19 s`, all `X-Search-Source: preindex` ✓ (before: the 250 and the 100 were live queries). Tests: `api/tests/pins-search-preindex.test.ts` (8). |
| 🐢 **"Markers took minutes to load" — the background builder was starving the database the map reads** | ✅ fixed (11-12) | Owner report: *"markers seem to be taking a long time to load... in fact it took more then a few min when my friend tried to load"* [a 15-overlay URL over Idaho]. **THE MAP ITSELF WAS FINE — THE BOX WAS NOT.** The same URL measures **250 requests / 4 MB / 75 pins, settled in under 15 s** — but the box ran at **load average 23** while the new **pre-index builder** ran flat-out: every entry is one heavy search query (the ranking runs over the whole corpus), so a thousand of them back-to-back is a thousand seconds of **DATABASE TIME** — and the reader's marker fetch is the same database (`/api/pins/map` measured **1.27 s cold, 0.19 s warm** on a quiet box, and minutes on a loaded one). **THE BUILDER IS NOW A POLITE CITIZEN**: a **2-second pause between entries** and a **cap of 60 entries per pass** (the timer asks for a slice; the whole list still refreshes, it just does not starve the site while it does). **ALSO FIXED: THE RELATED STORIES ARE LINKS** — *"we need to be able to click on them and immediately go to the website that is linked or related"*. The tree API has carried each article's `url` all along (the publisher's own page) and the popup rendered the headline as plain text with a click that **flew the map instead** — so the link was there and was not used. **The headline is now a link** (target=_blank, so the map stays) and the **◎ button** beside it is the map move, so neither action is lost. **Measured live: 45 related stories, all real publisher URLs.** Tests: **`popup-related-stories.bun.test.js` (5)**. **NOTE FOR THE OPERATOR: the other half of that load was NOT this session's** — `worker.nn_batch_links --limit 3000 --min-score 0` runs at 60 % CPU on its own, and `nn_infer` beside it; they are the pipeline's own jobs and are worth a look (README Q-N37). |
| 🌡️ **THE CHANGE MAP — the pressure of ONE analysis, and the CHANGE in it over any window** | ✅ shipped (11-12) | Owner ask: *"it would be nice if we could show a 'secular' version of the pressure maps.. so you click on a 'delta' and you can select to see the 'change in the last 24 hours map and kinda show a new isometric pressure map with lines of change.. 1 moon cycle meaning 29.(moon phase).. 1/4 (per season) a year 1/2 a year 1/3 1/6 a year or 1/8 a year 2/3 a year or one full year"* — and *"we still want to support 0.10 hPa 0.25 0.5 1 2 4 8 16 hPa for all the new maps as well correct?"* **THE CHANGE MAP IS THE Δp MAP — the pressure anomaly, what a synoptic chart calls the tendency: where the air ROSE and where it FELL.** The isobar layer's legend now carries a **CHANGE** row (⚙ → Pressure lines → CHANGE): **pressure** (the ordinary chart) · **24 h** · **3 d** · **7 d** · **moon** (29.53 d) · **season** (91.3 d) · **year** (365.25 d). **THE ARCHIVE HOLDS THE FIELD, NOT THE LINES** — a difference of two sets of contour lines is not a field (you cannot subtract a polyline), so `worker/pressure_delta.py` archives the 1° pressure field of every cycle (130 KB a cycle, **190 MB a year**) and the API differences two of them on demand, for ANY window and ANY past cycle; storing the delta per window would cost 1.5 GB a year for a field that is 190 MB. **THE CLIENT CONTOURS IT** (`public_html/delta-contour.js`), so **EVERY STEP OF THE LADDER WORKS FROM ONE FETCH** — 0.10, 0.25, 0.5, 1, 2, 4, 8, 16 hPa ✓ — and the server never contours a delta at all, so there is exactly ONE contouring implementation and nothing to drift. **THE GRID IS AT 0.05 hPa PER UNIT — THE GCD OF THE LADDER** ✓ (the same rule the isobar worker already follows: 0.25 is NOT a multiple of 0.1, so a 0.1 hPa grid could not hold a 0.25 hPa level at all). **THE CHANGE MAP GETS ITS OWN DIVERGING RAMP** — blue where the pressure fell, red where it rose, pale in the middle — because the pressure ramp (940–1060 hPa) means nothing on a map of differences; the labels are signed and carry their unit (**"+8 hPa"** / **"−3 hPa"**). **THE WINDOWS LIGHT UP AS THE ARCHIVE FILLS**: 24 h / 3 d / 7 d work **now** (the worker backfilled the ten days NOMADS keeps), and the lunar cycle, the season and the year are **greyed out with the reason** until the archive is old enough — a year-long change cannot be computed until a year of fields exists. Tests: **`api/tests/weather-delta.test.ts` (3)** and **`public_html/tests/delta-contour.bun.test.js` (8)**. |
| 🗺️ **The about page now answers WHY — the founder read a map of the world in the mineral rings of Grand Prismatic Spring** | ✅ shipped (11-12) | Owner ask: *"we need to add more details about WHY we made xyzo.org"* — with the founder's own account of standing at **Grand Prismatic Spring** in Yellowstone, reading the concentric mineral bands as **Antarctica at the centre, the north pole at the rim, a green patch for Greenland**, and coming home with two rules: **a map that can change**, and **be careful where you bring electronics and what you take photos of**. The page (linked from the map footer and the help panel) now carries the story as the site's origin: the spring is not a picture of a map, it is a map **being made** — which is what this site is; and the manners the trip taught are the same manners the crawler follows, because *a geyser does not consent to being photographed and a publisher does not consent to being crawled*. It also answers the question the account ends on, plainly: **"Not the map of the universe — nobody has that, and anyone who says they do is selling something. But the map of *today*: every story, every place, every connection, free and open and updating while you watch. That one exists. It is this page."** **THE THREE MAPS ARE GROUNDED IN WHAT THE SITE ACTUALLY HAS** — the ground you are standing on, the globe (the 🌐 button on the zoom bar), and the web of connections (the story tree) — with the site itself being the third. **THE EDITORIAL RULE (pinned by a test): the account is ATTRIBUTED, never asserted as fact** — the founder's words are carried as his words, and the private parts of the story are **not** published: a public page is not the place for someone's worst night, and the map is the part that belongs to everyone. It also notes the one thing the site's new **TIME MACHINE** makes literal: the map of the past is a lookup, not a memory. Tests: **`about-why.bun.test.js` (6)**. |
| 📍 **A PIN NOW SAYS WHERE IT IS — the coordinates, the town, and a satellite view of the exact spot** | ✅ shipped (11-12) | Owner ask: *"when you click on a point.. can you have it show the details of that point including the google popup map showing the satellite view for example lat/lng and anything else a user might want to know about that point... nearest town nearest news... if that takes too long dont do it.. just show something so they can see at least the lat/lng and a few other things that are fast for us to provide"*. **EVERYTHING HERE IS ALREADY IN HAND — no request, no wait.** The pin carries its own coordinates, its place, its source and its time; the **nearest news** is the "Related Stories" section the popup already had (the event's other articles); the **nearest town** is the place badge the popup already had. The popup now reads **"📍 48.85771° N · 2.34884° E"** under the title, with a **📡** button (the satellite view) and a **📋** button (copy the coordinates) beside it. **THE SATELLITE VIEW IS A BUTTON, NOT AN EMBEDDED MAP** — it is a NESTED Leaflet map (a second map to build, four Esri tiles to fetch), so opening it automatically would make every pin tap wait for a picture of a field, which is exactly the *"if that takes too long dont do it"*. Clicked, it opens the existing satellite popup (the mini-map plus the Google and Bing satellite links ✓). **TWO TRAPS, both measured, both worth the record.** (1) **THE POPUP'S CONTENT IS 914 px LONG IN A 380 px SCROLL BOX**, and the content wrapper carries a CSS `zoom: 1.15` — so anything placed low in the popup is BELOW THE FOLD, and **clipped content is not hit-tested**, so a button down there is invisible AND dead (the first version put the satellite button in a block at the bottom, and it did nothing at all). The numbers and the buttons therefore live in the **header row**, which is always visible, and the content box was given the room the extra row needs (`maxHeight` 380 → **440**) so the EXISTING actions (view, Fix, Report…) stay visible too. (2) **THE LISTENERS ARE DELEGATED FROM THE POPUP ELEMENT, NOT BOUND TO THE BUTTONS** — the popup's content is a FUNCTION, so Leaflet rebuilds it and the buttons are replaced by brand-new nodes; a listener bound to a button dies with the old one (the same rule the close button follows). **MEASURED LIVE** (Playwright, desktop **and** a 393×852 phone): the 📡 button opens the satellite popup with **4 Esri tiles** on both, the ✕ and the existing actions still work, **0 page errors**. Tests: **`popup-point-details.bun.test.js` (5)**. |
| 📏 **THE MAP NOW SAYS HOW FAR IT IS — the flat map had NO scale bar at all** | ✅ shipped (11-12) | Owner ask: *"can you show a distance measure on the map for all the maps i dont see it is it hiding under the 'help me' tab? its nice to know distance based on the zoom level"*. **THERE WAS NOTHING TO HIDE: the 3D globe has had a scale since it was written (`maplibregl.ScaleControl`) and the FLAT map had NO scale control at all** — Leaflet's `L.control.scale` was never called, so the corner the reader was looking in was empty. **IT IS IN THE BOTTOM LEFT**, because the bottom right of the flat map belongs to the **"Help me" pill** (position: fixed, z-index 9998 — it covers whatever is in that corner) and to Leaflet's attribution control, the top left is the zoom bar and the top right is the layers dropdown; the bottom left is the only corner with nothing in it. **IT FOLLOWS THE ZOOM** — measured live: "2000 km" at zoom 2, "10 km" at zoom 10, "3 km" at zoom 12. **METRIC ONLY**, like the globe's (the site is international; "both" is two numbers and two rules for one bar). **ON A PHONE IT CLEARS THE BOTTOM BAR** (which spans the width): the bar's top edge is MEASURED (`--bottom-bar-top`), and the rule that does it must carry **the same selector as Leaflet's own** — the vendored stylesheet sets `.leaflet-bottom .leaflet-control-scale { margin-bottom: 5px }`, and a lower-specificity rule simply loses (measured: the bar sat at the very bottom, UNDER the bottom bar — the same "where did it go?" as not having one). It also sits **under** the live panel (z-index 350 against the panel's 400) so it never floats over a panel that is reading the news. **BOTH VIEWS NOW WEAR THE HOUSE LOOK** — a dark pill, a light rule, the number in the map's own type — because MapLibre's default is a bright white box in the corner of a dark globe. Tests: **`map-scale-bar.bun.test.js` (4)**. |
| 🕰️ **A YEAR OF THE WEATHER MAPS — the reader can now pick a date and see the map as it was** | ✅ shipped (11-12) | Owner ask: *"can we also save the 'maps' wind maps and temperature for 1 year.. so for example people can type in the date and see what it looks like for the past year.. maybe also keep the time too.. if it takes less then a few gigabyets its maybe worth it.. pressure wind temp and maybe news for that day? why not?"* **THE THREE WEATHER WORKERS REPLACE THE PREVIOUS CYCLE WHEN THE NEXT ONE LANDS, so the past was not a lookup — it was gone.** `worker/weather_archive.py` copies every GFS analysis cycle (four a day) into `data/weather_archive/<cycle>/`, and `GET /api/weather/archive/{wind.bin,temp.bin,isobars.json,meta.json}?at=<iso>` serves it. **THE SIZE, MEASURED: 369 KB A CYCLE — 552 MB A YEAR ✓ ("less than a few gigabytes").** The archive keeps the **1° grids** (the same ones the 3D globe draws: wind 196 KB gzipped, temperature 66 KB) and the **classic 4 hPa pressure chart** (103 KB, 265 lines) — because the 0.25° grids would be 6 MB a cycle (**8.8 GB a year**) and the 0.05 hPa isobar lattice is 39,320 rows (**350 GB a year**). The reader is told the resolution rather than being given a map that quietly looks different from the live one. **IT COPIES, IT DOES NOT RE-COMPUTE** — there is no second implementation of a field. **THE READER SIDE** (`public_html/weather-archive.js`): ⚙ → **TIME MACHINE** → a date and one of the four analysis times (00/06/12/18 UTC); the moment rides in the URL (`?at=`, the way a search rides in `?q=`), so a past map can be shared; the three weather layers ask the archive where their grid comes from and their **own archived meta** (the live meta describes today's analysis); the layers hold their grid in memory, so choosing a moment **empties and re-adds** them; and **the news drawn is the news OF THAT DAY** — a new `until` parameter gives the window its other end, because `since` alone would be every story since that day. **MEASURED LIVE:** the wind layer fetched `/api/weather/archive/wind.bin?at=…` and drew **1,234 particles** from the archived grid, the isobars came from the archive, **0 page errors**. Tests: **`api/tests/weather-archive.test.ts` (7)** and **`public_html/tests/search-weather-archive.bun.test.js` (9)**. |
| 📱 **After a search on a PHONE, the pin popup opened OFF-SCREEN — 970 px above the top, ✕ un-tappable** | ✅ fixed (11-11) | Owner report: *"after a search on a phone, the pin popups do not show up correctly"*. **THE MEASUREMENT (`scripts/search_mobile_audit.py`, a 393×852 Chromium phone profile with REAL touch — the first mobile audit this site ever had; every other Playwright script here drives a 1280–1440 px desktop):** tapping a search result put the popup at **558,−474 → 927,−94** in a 393×852 viewport — the **✕ Close at 834,−464 → 917,−432, i.e. 464 px above the top of the screen and 441 px past the right edge**, so it could not be tapped and the popup could not be closed. **4 of 9 checks failed. AFTER: 10,215 → 379,595, the ✕ at 286,225 → 369,257, the popup still for 1.5 s, and tapping the ✕ closes it — 9 of 9 pass** (chicago · tokyo · new york, 4 runs). **FIVE DEFECTS, ONE MEASUREMENT.** (1) **THE FRAMING PANNED THE WRONG WAY.** `map.panBy([dx, dy])` moves the map's **CENTRE** by (dx, dy), so the popup — anchored to its pin — moves the **OTHER** way; the correction had the **same** sign as the screen-space error, so every correction pushed the popup **further** off: measured, the popup walked from **34 px past the right edge to 970 px above the top in FOUR corrections, each DOUBLE the last** (each was computed from the position the previous wrong-way one had produced). (2) **THE POPUP OPENED INTO A FLIGHT.** Leaflet's own `click → _openPopup` handler opened it **synchronously** — 0 ms into the **700 ms** `flyToBounds` that `maybeZoomToCluster()` starts for any pin with ≥3 neighbours within 30 km, which after a search is nearly every pin — so the popup **rode** the flight. (3) **THE FRAMING NEVER RE-RAN**: `keepPopupOnScreen()` ran at `popupopen` and one tick later, i.e. **during** the flight; nothing re-framed the popup once the flight landed. (4) **THE STATUS LINE WAS NOT RESERVED**: `#search-status` ("All news in Chicago · 9 stories") is `position: fixed; bottom: 58px` and only exists **after a search**, and the framing measured the bottom bar's **HEIGHT** — ~14 px short of its measured top edge (`--bottom-bar-top`). (5) **THE MOBILE "Details ▸" BUTTON WAS DEAD**: the mobile branch emitted `.popup-details-full` while the wiring looked for `.popup-details-content`, so on a phone the keywords, the related stories, the locations and the reports were **unreachable**. **PLUS TWO MORE THE SAME AUDIT FOUND:** `maybeZoomToCluster()` counted every pin **twice** (the canvas list and the DOM marker registry hold the same search results), and `restoreActivePopup()`'s standalone popup was never wired, so its action buttons were dead. **AND THE FIRST-VISIT TOUR WAS THE THING THAT FINISHED THE JOB:** the tour card is the only thing the tour puts on the **pointer path** (z-index 9998, above the popup pane; a bottom sheet on a phone) — measured, the element at the ✕'s own coordinates was `xyzo-tour-title`, so the tap landed on the tour. **A search now ends the tour** (`endTourForSearch()`). **THE FIX, IN ONE PLACE:** `openPopupWhenSettled()` — one helper the DOM-marker, canvas-pin and event-marker paths all call; it waits for `moveend` with a fallback that **re-arms while the map is moving** (a 700 ms flight is LONGER than the 600 ms coarse-pointer wait, so a fallback that simply fired opened the popup 600 ms **into** the flight — the very bug). The framing now also runs on `moveend`/`zoomend` (but **never** against a user drag), the correction is **rounded before the zero test** (Leaflet's `panBy([0,0])` fires `moveend` without moving, which fed the framing pass into itself → *"Maximum call stack size exceeded"*), and the canvas shift hack reads **the popup's own element** and stops when the map settles. **Tests: `public_html/tests/search-mobile-popup.bun.test.js` (16).** |
| ⚡ **A search took 24–75 SECONDS — and the top 1,000 queries are now answered IN ADVANCE** | ✅ fixed (11-11) | Owner ask: *"lets check that various searches are working and also fast.. we want to preindex the top 1000 or so searches so that theya re all very fast.. in the background we can always update the REAL LIVE data we just want fast results to start with"*. **THE MEASUREMENT: the same endpoint was 0.22 s on a cache hit and 24–75 s on a miss** (tokyo 34.6 s · india 26.6 s · israel 37.9 s · london 24.4 s) — a 1.2 MB answer and a 64 MB RAM cache holds ~40 of them, so every search evicted the others. **THREE CAUSES, THREE FIXES.** (1) **ONE UN-INDEXABLE LEG INSIDE THE OR MADE THE PLANNER SEQ-SCAN THE WHOLE CORPUS.** Four legs are served by the trigram GIN indexes; the fifth (`source_kind = 'web_discovered' AND discovery_query ILIKE '%q%'`) is served by nothing — and it is worth **20 ROWS in the entire corpus**. A partial GIN index over exactly those rows makes the leg indexable (the planner had been reading **397,043 buffers — 3.1 GB of I/O** to produce 978 rows). (2) **THE FUZZY RULE WAS THE WRONG SHAPE**: whole-string `similarity(title,t) > 0.3` cannot reach 0.3 against a long title, so it pulled **1,149,700 index tuples and 584,762 heap rechecks** for 1,584 rows — **25,463 ms**. Word similarity (`%>`) compares the query with a WORD in the title: **102 ms**, and it is the better rule too — it finds *"Chinese companies bag contracts…"* for **china** and *"Japanese President"* for **japan**, which the substring rule misses ("chinese" does not contain "china"); measured over the real query mix it **loses 0–3 rows per query and gains up to 10,961** (all of them about China). The rows it loses are junk ("Tok tok tok"). (3) **THE STATEMENT WAS PLANNED GENERICALLY** — the text is the same for every search, so after five executions Postgres switched to a generic plan and re-picked the seq scan: **718 ms custom vs 37,679 ms generic**. Now `plan_cache_mode = force_custom_plan`. **PLUS:** the entity branch ("nvidia" → Santa Clara) matched a free-text field on 3.59 M rows and cost **155,931 ms**; the city is resolved to its `news_locations` row first (45 k rows, a millisecond) and the article side became `location_id = ANY(...)`. **AND** `/api/locations/search` — called on EVERY search — counted the articles of all 45,231 locations before answering about a handful: **2,050 ms → 67.7 ms** with an index-only per-location count. **AFTER (live):** tokyo **0.94 s** · india **1.3 s** · volcano **0.58 s** · nvidia **1.78 s** · artificial intelligence **2.5 s** · locations **0.33 s**. **AND THE PRE-INDEX:** `search_preindex` holds the answer to the top ~1,000 queries, computed by `worker/search_preindex.py` on a 15-minute timer — it calls **our own API** (so the search SQL has one implementation) with **`X-Search-Fresh: 1`** (so it gets the LIVE answer, not the one it is replacing). What is stored is the ANSWER, not the stories: the payload points at live rows, so titles and images are always current; the key carries the time WINDOW, not the timestamp; and the response says how old it is. Tests: **`api/tests/pins-search-preindex.test.ts` (6)**, the migration `2026-11-11-search-text-indexes.sql` (2 indexes), `2026-11-11-search-preindex.sql` (the store + the top-queries table the search path now writes). |
| 🌏 **A search for a COUNTRY landed on a CITY — "china" → Chinandega, Nicaragua; "india" → Indianapolis** | ✅ fixed (11-11) | Owner report: *"when we search for something it zooms into the wrong area… i just searched for 'china' and it zooms into `#12.6283,-87.1326,9`… it also says **No news found near Chinandega, Chinandega Department, NI**… this is a generalized problem"*, then *"a search for 'india' zooms into indianapolis this is wrong as well"*. **ONE DEFECT, MEASURED: `detectCitySearch()` PREFIX-MATCHES** — and in every case the query is a prefix of a bigger city's name: **china → Chinandega NI (126k) · india → Indianapolis (887k) · peru → Perugia IT · florida → Florida, CUBA · maine → Maine Township IL · korea → Koreatown CA · virginia → Virginia, SOUTH AFRICA**. The city branch then fetched pins **by bbox, not by query** and framed the city — hence "No news found near Chinandega" for a search about China. **NO STRUCTURAL RULE CAN FIX IT**: "china"→Chinandega and "chica"→Chicago are both mid-word prefixes of a city name, and prefix matching must keep working while the reader types ("new" → NYC, "kansas c" → Kansas City). **THE FIX, THREE PARTS.** (1) **`BIG_PLACE_NAMES` in `city-engine.js`** — ISO 3166 country names + the forms people type ("usa", "ivory coast", "burma", "holland") + the 51 US state NAMES derived from `US_STATES` (one table, not two), normalised by one `normPlace()` on both sides; `detectCitySearch()` returns null for an exact match, so the query falls through to `/api/geocode` + `/api/pins?q=` — all three city-path call sites go through that one function. (2) **THE GEOCODER ANSWERS IN THE LOCAL SCRIPT** — measured live: `china` → **中国**, `japan` → **日本**, `korea` → **대한민국**, `brazil` → Brasil, `turkey` → Türkiye — so the name gate would still reject the country; `frameSearchRegion()` now accepts an answer that is BOTH an **administrative** area (Turkey, **TEXAS** is a town and still loses) AND for a query on the list ("climate" never reaches the clause), passed in as a **parameter** so the framing stays a pure function of its arguments. (3) **THE EXTENT CAP WAS TOO TIGHT FOR COUNTRIES**: `25°×40°` rejected China (44.9×61.3), India, Brazil, Canada (41.7×88.7) and Australia (46.2×96) → point at z6 showing a slice; now **`60°×100°`**, which still rejects the US box (86×360 — Wake and Guam), Russia (360 across the antimeridian) and continents — fitting those would zoom out to the whole planet. **VERIFIED LIVE (Playwright):** china → **34.0,104.1 z4**, status *"133 matches · 30 new events · China · 191 stories"*; india → 21.8,82.7 z5; peru → −10.3,−76.6 z5; florida → 27.7,−83.8 z7; unchanged: el salvador z9, tokyo z7, chicago z7, climate change → world; **0 page errors**. Tests: **`search-country-hijack.bun.test.js` (17)** — runs the SHIPPED city-engine against the real `cities.10k.json` and the framing against live-API fixtures; suite **1680 pass / 0 fail**. |
| ⚡ **Isobar loading: two full-table scans for METADATA, and an ETag formed after the query** | ✅ fixed (11-10) | Owner ask: *"can we do a deep study on what we can do to speed up isometric pressure bar loading? do some timing analysis and benchmarking."* **THE LINES WERE NEVER THE PROBLEM — THE METADATA WAS.** Every `GET /api/weather/isobars` ran two full-table scans to find out *what was published*: `SELECT source, MAX(run_time), COUNT(*) … GROUP BY source` = **Seq Scan, 36,938 buffers = 288 MB, 1,577 ms**, and the per-source `COUNT(…)` = **Bitmap Heap Scan, 23,871 buffers = 186 MB, 606 ms** — **~474 MB of I/O on every single request**. That is why the endpoint swung with the load rather than with its own work: the identical SQL run standalone took **580 ms end to end** while the live route answered the same URL in **4,147 / 28,093 / 30,250 ms** across three consecutive runs (box at load 17). **THE ETag WAS FORMED AFTER THE QUERY** because it included `items.length`, so a **304 carrying an empty body** cost `x-response-time` **28,543 ms** — and the comment beside it promising *"a ~10 ms round trip"* was true only of the transfer, not of the handler. **THE FIX, THREE PARTS.** (1) **`readPublished()` reads `weather_isobars_build` — 2 ROWS, ~1 ms** — which `worker/isobars.py` writes in the **same transaction** as the DELETE and the INSERTs, so a build row exists if and only if that source's rows do; it carries `run_time`, `interval_hpa` and `built`. (2) **The counts that still need the big table are computed ONCE per publish and cached against `built`** (`now()` on every publish, so a same-cycle re-cut invalidates it) — and **a database with no build row never caches**, which is the test DB: it seeds `weather_isobars` directly, and a cache keyed on an empty key would hand one test's counts to the next. (3) **The covering index `idx_weather_isobars_src_meta (source, run_time, level_hpa)`** — 6.3 MB against the 389 MB table — so the fallback count is index-coverable. **THE ETag NOW FORMS BEFORE THE QUERY.** With a build row the row set is a pure function of the query and that record, so `items.length` is redundant and a conditional request answers **without reading the table**; with no build row nothing vouches for the row set, so the ETag is formed after the query *with* the count and the early return is not taken — nothing can be told "unchanged" that is not. **MEASURED, `x-response-time` before → after:** the owner's own `step=0.1` 63×26° view **18,361 ms → 302 ms**; city 1×1 `step=1` **2,615 → 11 ms**; world `step=0.25` **1,068 → 97 ms**; `/weather/isobars/meta` **→ 1 ms**; **a conditional request 28,543 ms → 1 ms** (`x-phases: stats=0 main=skipped rest=0`), while a *different* bbox still correctly answers 200. Tests: `weather-isobars.test.ts` **13 → 16** (+3 — the 304 must skip the query, asserted on `x-phases` **because the old code also returned 304, just after the scan**; a changed viewport is still a 200; a re-publish moves `built` and must not 304), frontend **1638 pass / 0 fail**. **THE VARIANCE HAD A ROOT CAUSE THIS DID NOT FIX:** one session (pid 2782529) had been **idle in transaction for 16.2 hours**, holding `backend_xmin` **420,000 transactions** behind the horizon — so `VACUUM weather_isobars` completed in **0.18 s and reclaimed NOTHING**, leaving **120,328 dead tuples against 41,266 live** (395 MB) and a **clear visibility map**, which is why the new index's index-only scan still degenerated into **161,594 heap fetches**. The same session holds back autovacuum on the 16 GB `news_articles`, where a `COUNT(*)` was measured at **104 s**. **TERMINATED 11-11 on the owner's go-ahead, and it was the right call: the first pid had already gone but a NEW one (3528846) had the identical query stuck 10.4 hours — a recurring LEAK, not an incident.** Horizon **410,068 → 3,355**; `VACUUM` **3.96 s → 80,676 dead → 0, 397 MB → 241 MB**; index-only scans **Heap Fetches: 0** at **6.3 / 7.0 ms**. Endpoint **18,361 ms → 238 ms**, conditional **28,543 → 3 ms**. **The leak itself is Q-N30 and is NOT fixed.** |
| 🌊 **The isobars and the tectonic faults did not cross the Pacific** | ✅ fixed (11-10) | Owner, at `#49.1961,175.6055,5`: *"notice the pressure lines show up on the left but not right?"* — and then *"the tectonic faults need to work across the pacific ocean"*. **THE DATA AND THE FETCH WERE BOTH CORRECT.** That view's bounds are **143.96 … 207.25** (Leaflet's continuous longitude, east past 180); the API answers that exact bbox with **1,157 lines**, and **499 + 658** for the two halves separately — *exactly the same total*. All 1,157 were being drawn. **THE PROJECTION WAS THE PROBLEM.** Leaflet anchors its CRS at the map CENTRE (175.6), so a vertex at **−170** — which belongs **14° EAST** of centre — is placed **345° WEST** of it: off the left edge. **MEASURED by projecting every drawn vertex to a container point: 127,530 of the 250,609 vertices carry a NEGATIVE longitude — the Pacific east of the dateline, i.e. the RIGHT half of this view — and ALL 127,530 project off the LEFT edge. Zero on screen.** Only 2,203 vertices, the 175.6–180 sliver, appeared on the right. **AFTER: 19,673 on the right, right/left 0.11 → 0.88.** **THE FAULTS WERE BROKEN TWICE, AND THE FIRST IS THE WORSE ONE.** (1) `candidates()` read the viewport as `west <= east` and took the SINGLE-SPAN branch — so it scanned cells `floor(121.8/CELL) … floor(229.4/CELL)` and **never the NEGATIVE cells holding the faults east of the dateline**. Measured: **842 selected where a dateline-aware scan finds 2,143 — 1,301 missing (61 %)**, and not one added feature had a negative longitude. `viewSpans()` now splits any viewport that leaves `[-180,180]` into spans inside it, while keeping the *other* wrapping convention (`west > east`) the old code already handled. (2) Selection is not rendering — the same CRS problem applied, so `wrapLine()` moves each trace's vertices too. **AFTER: 842 → 2,143 features, right-half vertices 33 → 427.** **THE FIX'S OWN BUG, FOUND BY FLYING OFF THE DATELINE.** The first version anchored EVERY vertex to the centre, which **tears a line in two**: a trace stored as `144 … 207` had its second half pushed to `−160 … −153` while the first stayed at `144`, and Leaflet then drew one **310° chord straight across the map** — measured as 69,867 px of horizontal bands over Europe, 5.39 % of the screen, attributable to the isobars alone. **The line must stay CONTIGUOUS**: the first vertex goes within ±180° of the centre and every later vertex within ±180° of its PREVIOUS one. **`far` is no longer a failure metric** — a long line legitimately runs past ±180° from the centre, it is simply off-screen; the invariant is **max adjacent-vertex step ≤ 180°**, measured at **10.0°** for the isobars and **2.0°** for the faults. **VERIFIED FOUR WAYS**: the dateline view (isobars 2,314/1,943, faults 382/427); a FRESH European view (isobars 750/511); **flying** from the dateline to Europe *without reloading* — the rewrap path, which a fresh load never exercises — landing on 48 European lines at 750/483 with maxStep 10.0°; and **Paris unchanged** (750/511, 0 console errors), because the wrap is a no-op when every vertex is already within ±180° of the centre. **`_viewSpans` and `_wrapLine` are EXECUTED, not grepped** — they are pure functions of numbers — and because the two modules each carry their own copy (they do not import from one another) a **parity test runs the same four inputs through both and demands identical output**. Tests: **1636 pass / 0 fail**, +2 in `fault-layer.bun.test.js` and +3 in `isobar-layer.bun.test.js`. |
| 🎚️ **A control for how many wind marks there are — slider AND typed, carried in the URL** | ✅ shipped (11-10) | Owner ask: *"can we create something to control how many wind dots or elements we have like a slider or some way to type it in whatever you think is best… it might be nice to be able to control this and also have the URL updated so you can share exactly what you want"*. **A PERCENTAGE of the automatic count, not an absolute number**: the count is derived from screen area ("one particle per ~420 px² keeps density even across screen sizes"), and an absolute count would break exactly that — 5,000 dots is sparse on a 4K monitor and sluggish on a phone. A percentage scales each screen's OWN baseline, so a shared link reproduces the same LOOK everywhere. **It rides as the THIRD field of `wind=`** (`wind=particles:speed:200`), not as its own segment: the URL already has `density=` and it means PIN density (`density=max`), and two settings called density in one hash is how a reader ends up with the wrong one. **THREE READERS HAD TO MOVE TOGETHER**, and the old regex was `$`-anchored with two fields — so `wind=particles:speed:200` matched NOTHING and the whole segment, style and colour included, was silently dropped. That is the trap the `iso=` colour suffix had, one field further along. app.js and map-presets.js now carry the **same regex literal** (compared as literals, not extracted: the pattern contains `/` inside a character class, so no "grab between slashes" expression can find its own end), and **globe-wind.js's reader is EXECUTED** against the same inputs rather than grepped. **THE SEGMENT IS WRITTEN WHENEVER THE WIND IS ON, defaults and all** — the `iso=` rule — because omitting it hands the READER's stored style, colour and density back at the sender. **A CHANGE ANNOUNCES ITSELF** (`xyzo:wind-style`, one event for all three setters) → `updateUrlHash()`: the share button copies `location.href` VERBATIM, so without it, changing the density and pressing Share without panning first handed over the PREVIOUS density — and style and colour had that same gap before this. **ALL FOUR STYLES HONOUR IT.** Particles and streamlines scale the pool; **flow's pool is GROWN on demand** — it is allocated once for the DEFAULT count, so at 200 % the loop indexed past its end and read `s.age` on undefined, killing the frame; arrows use `ARROW_MIN_PX / Math.sqrt(density)` because a grid's count goes as the SQUARE of the cell, so taking the number at face value would make "200 %" draw FOUR times as many arrows where the particle styles draw twice as many — the same slider meaning two different things depending on the style selected; and **the arrow redraw key now carries the density**, or a density change with no view change left the OLD grid on screen (the slider would appear to do nothing in arrows style specifically). **THE GLOBE** scales `PARTICLE_COUNT` and its loop now SHRINKS as well as grow — it only ever grew, so dropping the density left the extra particles running for the rest of the session. **THE CONTROL IS BOTH A SLIDER AND A NUMBER BOX**, because they answer two different questions (drag to find a look, type to set one), both driving ONE writer (`setDensity`) so they cannot disagree — with **`step="1"` on both**, since a range input SNAPS to its step when set programmatically, so a step of 5 would silently turn a typed 27 into 25 on the slider while the box still said 27. The row prints the **real mark count** for the current style (dots / streaks / arrows), read back from the layer rather than recomputed. **THREE BUGS FOUND BY BUILDING IT.** (1) The first readout was called from `ensureParticles()` — which is on the path that SPAWNS the field — and threw on a document with no `getElementById`: a **cosmetic readout took the whole animation down**, zero particles and a dead probe in a sandbox. It degrades now, and both repaint functions are guarded ("degrade, never throw"). (2) **`Number(null) === 0`, and 0 clamps to the 25 MINIMUM** — so a reader who had never touched the control would have opened the GLOBE at a quarter of the default density with nothing on screen saying so; **measured: `readDensity()` returned 25 for an empty hash**. (3) An empty number box is the same trap (`Number("") === 0`), so clearing the field would have set the lowest density instead of leaving it alone. (4) **A FOCUS GUARD I ADDED MYSELF CAUSED TWO MORE**, both found by driving the live control: it skipped rewriting a focused number box to protect against a per-keystroke path that does not exist (the box commits on `change`, never on `input`) — so typing 250 and then dragging the slider left the box at **250** while the slider said **400**, and clearing the box left it **EMPTY** while 400 was still in effect, because that branch returns through the very function which then refused to write. **MEASURED on the live site after the fix:** type 250 → both controls 250, hash `:250`, **3,085 dots**; slider → 400 → **both** 400, hash `:400`, **4,936 dots**; type 9999 → clamps to 400; clear the box → stays 400; **100 % → 1,234 particles, 300 % → 3,702** (exactly 3×); and a shared link `wind=particles:speed:300` opened cold (a real reload — `goto()` with only a hash difference is a SAME-DOCUMENT navigation and would measure the previous page) came up at 300 / 3,702 with both controls agreeing. **0 console errors.** **Tests: 1631 pass / 0 fail (88 files), 26 new in `wind-density.bun.test.js`.** |
| 🪨 **The soil-type key in the layers dropdown was INVISIBLE — #e6edf3 on a white panel** | ✅ fixed (11-09) | Owner report: *"can you correct it.. its difficult to see the soil types on the drop down for example Soil type — WRB group (HWSD v2.2) Acrisols Alisols Andosols…"* (with the key's HTML pasted). **THE THIRTY-FOUR SOIL NAMES WERE PAINTED IN THE DARK THEME'S FOREGROUND ON THE WHITE LAYERS DROPDOWN.** `.hwsd-legend { color: var(--fg) }` — and `--fg` is **#e6edf3**, the pale foreground of the DARK theme. **Measured: 1.18:1 against white, i.e. invisible** — and it was the **only one of the twenty-two keys in that dropdown** painted that way (every other key measures **12.6–15.9:1**). The same trap the languages legend had already (AGENTS.md: *"`var(--fg)` renders it invisible there"*). **THE FIX:** the key is painted for the panel it lives in (`#333` labels, `#222` title — the palette every other key uses), the names are **13px** (they were 11px, below the legibility sweep's floor), the swatches are **13×13 with a stronger border** (several WRB colours are pale — Alisols #ffffbe, Gypsisols #fef6a4, Regosols #fee3a4 — and vanish into white without one), and the grid columns are wide enough that **"Open inland water" is no longer cut to "Open inland w…"**. **THE MEASUREMENT IS NOW A GATE, NOT A ONE-OFF:** `scripts/legend_contrast_check.py` walks every key in the dropdown, measures every TEXT element against the background actually painted behind it, and fails under **4.5:1** or **11px** — **all 22 keys now pass (the worst is 4.83:1)**. **IT ALSO FOUND THE SAME DEFECT IN THE OTHER KEYS**: the licence credits under nine of them ("NOAA NCEP GFS · 2 m air temperature", "Beck et al. (2018) · CC BY 4.0") were **#888 on white — 3.54:1**, and the language count **#999 — 2.85:1**. **A licence credit nobody can read is a licence problem, not a style one**, so all of them are now **#666 (5.74:1)** at ≥12px. **AND THE KEY IS NOW FINDABLE**: it sat **3,200 px down a 5,000 px dropdown**, so a reader who ticked "Soil type" saw the map change and no key at all — switching the layer on now brings it into view (only when it is not already on screen). |
| ⚡ **A repeat search made the reader wait 3–90 s for an answer they had already seen — now the old answer shows at once and the fresh one replaces it** | ✅ shipped (11-09) | Owner ask: *"can you save searches its very easy to just save the data for common searches so we can make those faster and then update the results after the new search is done.. so immediatly show old results and then remind the user that we are still searching for new results and then notify again when the new results live results come? its takes up almost no memory to save the search right?"*. **THE MEMORY ANSWER FIRST, because it decides the design: the QUERY is free (a key is a few dozen bytes) and the RESULTS are not.** A 1,000-pin answer is **1.5 MB** of JSON (1,620 B a pin), of which `word_freq` alone is **711 KB (45 %)** — so "save the search" is cheap and "save the results" is not, and the two have to be kept apart. **THE BROWSER KEEPS THE RESULTS IN INDEXEDDB — DISK, NOT RAM**: the copies are **slimmed** (no `word_freq`; the popup fetches its keywords on demand from `/api/pins/:id/words`) → **773 KB a search**, capped at the **12 most recent** (≈**9 MB of disk**), and nothing is added to the tab's memory beyond what the live search already puts there. **THE SERVER'S COPY IS RAM, so it is now byte-budgeted**: the search cache had a **200-ENTRY** limit, and a search answer is up to 1.5 MB — a **300 MB ceiling** on the API process's memory, which an entry-count limit cannot express anyway. It is now a **64 MB budget** (~40 full answers) and the TTL stays a hard 5 minutes, because a cached answer older than that would be yesterday's news served as this morning's. **MEASURED ON THE LIVE SITE (a repeat search, API cache cold):** `t=0.23 s` → **"Showing saved results from 11/9/2026 · searching for newer…"** with the old answer already on the map; `t=1.80 s` → **"359 matches · 30 new events · updated ✓"** with the fresh answer in place. **THE FRAMING IS NOT SAVED AS A DECISION**: a saved answer is framed by the **same function** that frames a live search (`frameSearchRegion`), so a saved search can never put the map somewhere a fresh one would not. **ONE TRAP, FOUND BY MEASURING:** the first key used the `since` TIMESTAMP, and `getSinceDate()` snaps to a 60-second boundary — so the key changed every minute and the saved answer was never found again. The key carries the time **WINDOW** ("24h", "all", "custom:7") instead. |
| 🔤 **Searching "ai" matched the LETTERS — and then the map flew to a place called "AI"** | ✅ fixed (11-09) | Owner report: *"i did a search for ai and for some reason clicked on what was suggested and i get a map thats not related to ai… the strories dont seem to be related mostly becuase the ltters ai show up not ARTIFICIAL INTELLLEGENCE"*. **THREE SEPARATE DEFECTS, ALL MEASURED.** **(1) THE SEARCH MATCHED SUBSTRINGS.** `/api/pins?q=ai` matched `ILIKE '%ai%'` — so "said", "rain", "air", "detail", "campaign" and "again" all counted. **Measured on the corpus (2.99 M articles): 558,168 titles contain the letters "ai" somewhere, 59,100 contain the WORD — the other 499,582 are noise.** The reader's "artificial intelligence" was never the criterion. **THE FIX:** a term of ≤ 3 characters now matches a whole word (`\m…\M` — the rule the EVENT search has always used, now ONE implementation in `api/src/lib/wordmatch.ts`); longer terms keep the substring match so "coronavirus" still finds "coronaviruses". **The last hole was the PHRASE branch**: "ai" has expansion terms ("artificial intelligence", "machine learning"…) so it took the multi-term path, whose phrase match was still a bare substring — that is what drowned the expansions. **AFTER: all 1,000 results for "ai" carry "AI"/"artificial intelligence"/"machine learning"; zero noise** (and the query got FASTER: 3.8 s against 22–50 s for the long-term path). **(2) THE MAP FLEW TO A PLACE CALLED "AI".** `/api/locations/search?q=ai` answers with a junk row named **"AI" on Long Island, New York (353 events)** and `/api/geocode` answers with **ANGUILLA** — 2,700 km apart. The name-equality gate passed and the map went to Long Island at zoom 6. **THE FIX: the two oracles must CORROBORATE each other** — a location row is only a place if the geocoder agrees on where it is (`ANCHOR_AGREE_DEG` 6°), and a row that matched the name and was not corroborated is dropped from the map AND from the status line. **(3) THE CHIP BAR OFFERED A CHIP LABELLED "topic".** The extractor's prompt showed the model `"topic_tags": ["3-6", "short", "topic", "tags"]` and **many models copied it verbatim**: those four words are literal tags on thousands of articles ("3-6" 2,741 · "short" 1,482 · "tags" 1,395 · "topic" 1,265) and the chip bar offered them. **THE FIX:** the prompt shows an empty list and asks for the tags in prose, the extractor strips the words before writing them (falling back to the event type), and `/api/tags/top` filters them so the old rows cannot reach the chips. **MEASURED ON THE LIVE SITE:** "ai" → the world view with AI stories; "artificial intelligence", "climate", "nvidia" → the world view with their own stories; **"el salvador" → the country (13.70, -88.91 z9), "tokyo" → the city, "japan" → the point — all unchanged**. Tests: **1579 pass / 0 fail** (86 frontend files) + **2 new API test files** (both mutation-checked: they fail without the fix). |
| ⛈️ **The Δp CHANGE map froze the computer — 4–5 SECONDS of main-thread work per view, 28,171 lines, 916,632 points** | ✅ fixed (11-13) | Owner report: *"lets see what we can do to speed up the delta pressure maps.. they do load however they freeze up the computer and almost crash it.. rather then trying it out by clicking on it first make sure it loads fast without selecting that setting because it will most likely crash the system. try the other delta modes too and speed the load times up in general... we might need to rethink the entire way we display isometric pressure delta maps and isometric pressure in general"*. **THREE DEFECTS, MEASURED ON THE REAL 24-HOUR DELTA** (the 2026-11-12 → 2026-11-13 analysis, on the 1° field the archive holds). **(1) THE LEVELS RAN FROM -180 TO +180 hPa** — the **longitude** range applied to a chart about a *change* in pressure, which lives around zero: **3,601 levels** for the 0.10 hPa step where the field spans ~840, each a full pass over the 65,160 cells — **234 million cell tests**. **(2) THE FIELD WAS NEVER BLURRED**, while the LIVE chart is contoured from a Gaussian-blurred field (`worker/isobars.py::smooth_field` — σ = 2 cells, wrapping in longitude, nearest at the poles) precisely because the analysis carries structure below synoptic scale; the change map contoured the GRIB own noise, and a difference of two fields is **twice** the noise. **(3) THE WHOLE WORLD WAS CONTOURED AND THEN TRIMMED TO THE VIEWPORT**, so every pan paid for the whole globe — and the client already holds the whole field (130 KB). **BEFORE → AFTER (the shipped code, the real field, best of three):** the 0.10 hPa step goes from **4,247 ms / 28,171 lines / 916,632 points** to **1,572 ms / 12,024 lines / 583,362 points** at the world view, and from **5,372 ms** to **41 ms** at a continent, **3,933 ms** to **4 ms** at a country, **4,154 ms** to **0 ms** at a city. **MEASURED IN THE BROWSER by the metric that matters — the LONG TASK, the main-thread block that freezes the tab** (`scripts/delta_chart_check.py`): 24 h @ 0.10 hPa → **976 ms**; 24 h / 3 d / 7 d @ 1 hPa → **170 / 232 / 152 ms**. **THE ORDINARY PRESSURE CHART WAS NEVER THE PROBLEM** (`scripts/isobar_speed_check.py`): 0.10 hPa → 463 ms, 0.25 → 169 ms, 1 hPa → **0 ms**. **THE REWRITE WAS PROVED TO BE THE SAME ALGORITHM** — the hot loop was rewritten (it allocated ten arrays a cell) and the proof is a comparison against the previous implementation over a whole synthetic field: **byte-identical lines at every level**. It also **fixed a latent bug**: the last column neighbour was read from the *next row* instead of the grid first column, so the seam was contoured against a wrong value. |
| 🔍 **A search zoomed to an EMPTY FIELD — "artificial intelligence" landed on a research centre's front door in Würzburg** | ✅ fixed (11-09) | Owner report: *"when i search for 'artificial intelligence' it find some articles but zooms in to an area that doesnt have any stories.. cant we quickly calculate that 'region' and zoom out to the best area?"* — with the URL ending at `#49.7961,9.8988,10` (**Würzburg, zoom 10**) and a second run at `#34.1618,-33.3984,2` (**the middle of the South Atlantic**). **TWO CAUSES, BOTH MEASURED AGAINST THE LIVE API.** **(1) THE "PLACE" WAS A BUILDING.** `/api/geocode?q="artificial intelligence"` answers with the **"Center for Artificial Intelligence and Robotics"** in Würzburg — an **ELEVEN METRE** bounding box — and `/api/locations/search` answers with a junk row named **exactly** "Artificial Intelligence" pointing at that same door. The old gate was **NAME EQUALITY** ("the query IS a place"), so it passed, and the map flew to the door and zoomed to 10. The same is true of **"climate"** (the **Climate Pledge Arena** in Seattle — a stadium, 150 m across) and **"nvidia"** (the headquarters, ~100 m). **(2) THE REGION WAS THE BOUNDING BOX OF A WORLDWIDE SET.** The stories for "artificial intelligence" are in San Mateo, Kyiv, Quito, Perth and Paris; their box has its centre in the **South Atlantic, some 2,300 km from the nearest story** — the "empty area" the reader saw. **THE FIX — ONE implementation, `frameSearchRegion()`, shared by `runSearch()` and `runTextSearch()`** (each carried its own copy of the gate and they had already drifted: one read `geoMatchesQuery`, the other `geoStrong`; one read `event_count`, the other `events_count`). **A place may only frame the map when it is a REGION:** a box narrower than `MIN_REGION_DEG` (**0.05° ≈ 5.5 km**) is a point of interest — a building, a campus, a stadium — and is rejected (`rejectedAnchor`), which also stops the status line naming the building. **Otherwise the region is computed from the RESULTS** — the RAW story locations, never the renderer's spread positions, which are a lie about where a story happened — and **a result set that spans the world (`WORLD_SPAN_DEG` 90°) is framed by the WORLD VIEW**, because the box of a worldwide set has its centre in an empty ocean. **WHAT DID NOT CHANGE: a real place still wins** — "el salvador" → the country (**13.70, -88.91 z9**), "tokyo" → the city (**35.69, 139.69 z7**), "japan" → the point (z6). **AND THE MAP NOW MOVES QUICKLY:** the event search spawns a Python worker and can take **30–90 s**, so it is **started before the framing and awaited after it** — measured on the live site, the map moves at **4.2 s** instead of **14 s**. Pinned by `search-region.bun.test.js` (**19 tests**: the two measured collisions, the region from the stories, the world threshold, the early framing) and by a rewritten `search-place-navigation.bun.test.js` (the place gate, the extent cap and the box-centre agreement now live in the shared function — same assertions, new home). Tests: **1573 pass / 0 fail** (86 files). |
| 🌊 **The globe's basin OUTLINES were drawn at a sixth of the flat map's strength — and the reader's colour scheme was ignored** | ✅ fixed (11-09) | Owner: *"also not working in hydrological basins on the 3d map.. i dont see the black outlines"*, with the row's HTML showing `checked` at `value=100`. **THE DATA WAS FINE** — `meta.json` and `basins_major.geojson` both answer **HTTP 200** with all **235 features**, and the source, both layers (`basins`, `basins-line`) and `visibility: visible` were all correct, so the checkbox was telling the truth and the picture was still wrong. **TWO INDEPENDENT DEFECTS.** **(1) THE OUTLINE INHERITED THE FILL'S OPACITY BASE.** `line-opacity` was computed as `baseOpacity(o, "fill-opacity")` = **0.16**, where the flat map draws the identical 0.8 px hairline at **0.85** (`opacity: 0.85 * state.opacity` in `basin-layer.js`) — a **5.3×** difference on a hairline over a busy satellite basemap. The comment in the code gave the reason it looked deliberate (*"it must dim with the wash"*), but the wash and the outline are two different jobs: a wash you read terrain through at 0.16, and a boundary that has to be visible over it. **MEASURED on the live globe** (animations hidden; baseline noise **0 px**, so the numbers are real), against a fill-only baseline: shipped **5,119 px changed but only 2 above delta 40** — at 0.85 **11,558 px and 4,179 strong**; fill alone **65.7 %** of the screen. So the layer was **drawing a wash and no readable boundary** — `strong` is what "I don't see the outlines" looks like in numbers. **(2) THE GLOBE IGNORED `xyzo.basinScheme`.** The flat map's legend offers blue/red/black and colours each feature **by its kind** (`river` / `coast` / `interior`); the globe hardcoded a single `#38bdf8` for every feature. Verified by storing `black` and reading the paint back: it returned `#38bdf8` where the flat map was drawing `#0a0a0a`. **FIX:** `basinPaint()` sits **above** the `const OVERLAYS` that calls it (a `const` below its use is in the temporal dead zone and the whole module fails to evaluate — the isobar colour lesson), reads the stored scheme, and returns a MapLibre **`["match", ["get", "kind"], …]`** expression so one toggle still shows three kinds of basin; the line layer now multiplies **its own** `BASIN_LINE_OPACITY = 0.85`, and `applyOpacity()` reads the two bases **separately** so a slider drag cannot put the bug back on the first drag. **AFTER, on the live site:** `lineOpacity 0.85`, `fillOpacity 0.16`, outline **12,454 px changed / 4,729 strong** (was 2); with `black` stored the paint reads `river #0a0a0a / coast #1c1c1c / interior #333333` and the screenshots show black basin boundaries across the Congo. Only **basins** carries overlay `type: "fill"` — `language-regions` builds a fill layer under its own `type` and its own branch, so it is untouched. Two tests had pinned the old behaviour (*"the fill's outline layer multiplies the same base"* and the 0.16 assertion); both were wrong about what they claimed to protect — the file's own header says the basins should be *"a hairline over terrain you can still read"*, and its reference test already asserted the flat map's 0.85. Rewritten, plus a new scheme-parity test. **Same WebGL caveat as the wind dots:** verified in Chromium (this box's headless Firefox cannot mount the globe at all). Tests: **1557 pass / 0 fail**. |
| 🌬️ **The wind draws DOTS in both views now — 2D and 3D agree** | ✅ shipped (11-08) | Owner ask: *"can you make sure that we can have the 'dot' wind not the little long pieces… we want to have similar dots for both wind animations 2d or 3d"*. The flat map's `particles` style draws a filled circle with a **dark halo under a bloom**; the globe drew only long streaks, so a link carrying `wind=particles:speed` — the owner's own — opened on the globe as something the flat map would never show. **THE GLOBE NOW READS THE STYLE THE TWO ROUTES THE FLAT MAP USES:** `wind=particles:speed` in the URL **first** (a shared link's choice must win — the hash is the promise "share the exact map", and `globe.js` keeps the segment because `GLOBE_OWNED_PREFIXES` does not list `wind=`), then `localStorage["xyzo.windStyle"]` (the reader's own chips; Chrome and Firefox have **separate** localStorage), defaulting to `streamlines`. Only **`particles`** changes what the globe draws — `flow` and `arrows` keep the streak, because the globe has no fibre texture and no arrow renderer, and saying otherwise would be a claim the code cannot keep. **THE CONSTANTS ARE COPIED FROM `wind-layer.js` ON PURPOSE AND PINNED**: `globe.html` does not load that file, so `PARTICLE_R_MIN 1.9 / R_SPAN 1.5 / HALO_PX 4.6 / SPEED_BUCKETS 12` are a second copy — and a second copy that drifts is the trap the parity test exists for, so `globe-wind.bun.test.js` reads BOTH files and fails if one moves. The alphas are `0.9 × {0.5, 0.30, 1}` under `globalAlpha = opacity`, which evaluates to exactly what the flat map bakes into `base`. **MEASURED, not asserted from source:** Chromium on the owner's globe link → `readStyle() = particles`, controller `particles`, **900 particles**, wind canvas **5.85 % lit** against **3.19 %** for the same view in `streamlines` (two different pictures); Firefox on the flat map → **6.14 % lit for dots against 16.86 % for streaks**, and the screenshot crops show circles-with-dark-rings against long ribbons. **A DOT HAS NO TAIL**: the branch skips `p.hist` entirely and `continue`s before the trail code, and `setStyle()` clears every particle's history so switching back cannot paint one long line across the planet from the old path. **THE OCEAN CURRENTS ARE NOT DRIVEN BY `wind=`** — `style: sourceName === "wind" ? readStyle() : DEFAULT_STYLE` — because the flat map's currents have their own chips and their own default, and one segment must not restyle two overlays. **FIREFOX CAVEAT, MEASURED:** this box's headless Firefox has **no WebGL at all** (`AllowWebgl2:false restricts context creation on this system`, even with `webgl.force-enabled` + `MOZ_WEBGL_FORCE_ALWAYS`), so the globe cannot mount there and the 3D half could only be verified in Chromium — the **style reader**, the flat map and the service-worker console **were** verified in Firefox. **SW console lines: 0 in both engines**; **0 page errors** in Chromium. Tests: **1556 pass / 0 fail**, 8 new in `globe-wind.bun.test.js`. |
| 🧯 **A CANCELLED TILE is now a missing tile, not a ServiceWorker error** | ✅ fixed (11-08) | The third line in the series (after `sw.js:292` and `sw.js:310`): `Failed to load 'https://xyzo.org/api/tile/rain/2026-11-07/5/16/6'. A ServiceWorker intercepted the request and encountered an unexpected error. sw.js:416:11` — **and the tile itself answers 200 + `image/png` from the origin**, so the failure is client-side. It is an **ABORT**: the globe's raster source and Leaflet both drop in-flight tiles when the view changes, so a pan cancels a dozen fetches as a matter of course, and the caller discards whatever comes back. **`Response.error()` DOES NOT SILENCE FIREFOX** — it reports an error response exactly as it reports a rejection, which is why the earlier `networkError()` fix moved the blame but did not remove the line. **FIX:** both handlers gained an `onError` hook, and the **tile paths** pass `tileFallback()` — a **1×1 transparent PNG**, the same answer the `tileMirror` route gives for a tile that does not exist (HTTP 200 + `X-Tile-Mirror: cancelled_or_unreachable`). **THE THREE CALL SITES ARE THE WHOLE POINT**: `/api/tile/`, the external tile hosts and `/data/` images get it; **`API_CACHE` and `SHELL_CACHE` deliberately do NOT** — a failed script or a failed JSON answer must stay visible, or a real outage becomes a silent blank. **`/data/` needs its own hook because it serves two incompatible things**: PNG tiles *and* `.bin` grids read with `arrayBuffer()`. A transparent PNG handed to a grid fetch decodes as **68 bytes of garbage** and the layer reports a wrong-shaped grid instead of a missing one — so `dataFallback()` substitutes **only for image extensions** and leaves `.bin`/`.json` on `Response.error()`, which is what the wind grid's reload-retry is built on. **`sw.js` is served `no-cache, must-revalidate`, so no token bump was needed** — verified byte-identical to the repo in production (`tileFallback` ×1, `onError(err, request)` ×2, `dataFallback` ×1). **FIREFOX'S OWN CONSOLE CANNOT BE READ BY PLAYWRIGHT** (calibrated earlier this session — service-worker messages do not reach the CDP console), so the honest evidence here is structural: the tests assert the hook is *consumed* in both handlers, **before** `networkError()`, and that exactly three call sites pass it. Pinned by a new `offline-layer` test. Tests: **1556 pass / 0 fail**. |
| 🔇 **Firefox's `mozPressure` warnings WERE suppressible — and 16 scripts were frozen for a year** | ✅ fixed (11-08) | Owner report (with the satellite popup error): *"MouseEvent.mozPressure is deprecated. Use PointerEvent.pressure instead. leaflet.js:5"* and the same for `mozInputSource`. **THE GUARD SAID IT COULD NOT BE SUPPRESSED — AND THAT WAS WRONG.** `console-guard.js` carried the note *"cannot be suppressed from JavaScript — they are browser-native warnings generated at the C++ level"*, and its pattern list duly matched a message that **never passes through a console method**. **THE PROOF THAT IT WAS NOT THE BROWSER'S FAULT: the vendored Leaflet contains ZERO occurrences of "pressure"** — nothing in it reads the property. **Leaflet 1.1.1 copies the DOM event with `for (var j in src)`** (its `Util.extend`), and Firefox keeps `mozPressure`/`mozInputSource` as **enumerable getters on `MouseEvent.prototype`** — so that loop READS them, and reading a deprecated property is what prints the notice. **THE FIX: make the two getters NON-ENUMABLE** — the getter itself is untouched (a direct `e.mozPressure` still works, and still warns), but `for...in` no longer reaches it, so Leaflet never reads it. **MEASURED in Firefox on the live map: BEFORE, both warnings on every click; AFTER, silent** — with the map, the satellite popup and its mini map (4 Esri tiles) all unaffected. **AND THE REASON THE FIX COULD NOT LAND WAS WORSE: `console-guard.js` HAD NO `?v=` TOKEN.** A `*.js` is served **`max-age=31536000, immutable` for a YEAR**, so **every reader who had loaded the site since 2026-10-21 (when that file last changed) was running a frozen copy** — and so was anyone else. **16 of index.html's 67 scripts had no token at all**: `console-guard.js`, `i18n.js`, `command-bar.js`, `analytics.js`, `presence.js`, `city-engine.js`, `submit-sniff.js`, `debug-panel.js`, `update-check.js`, `viewport-nudge.js`, `cache-debug.js` and the five vendored libraries — three of which had changed inside the freeze window (`analytics.js` 11-01, `city-engine.js` 10-31). **They are all stamped now**, `bump_frontend.sh`'s `ASSETS` covers them, and **the gate is new**: `frontend-hygiene.bun.test.js` fails if any `<script src>` in index.html lacks a `?v=`, or if one is not in that list (three named exemptions: `overlay-opacity.js` and `map-presets.js` move one at a time, `help-me-chat.js` is a lazy chunk). **Verified live in Chromium and Firefox after the re-stamp: the page boots, the first-visit map is still the owner's 15-overlay map, the satellite mini map still builds, and the console is CLEAN — 0 errors, 0 warnings.** |
| 🛰️ **The satellite popup's mini map could land in the WRONG popup — and threw "Map container is already initialized"** | ✅ fixed (11-08) | Owner report: *"Uncaught Error: Map container is already initialized. _initContainer … openSatellitePopup app.js:6365"* (his console also showed Firefox's own `MouseEvent.mozPressure is deprecated` — **that pair is Leaflet 1.1.1 reading a Firefox-only field, and it is noise, not the fault**). **THE MINI MAP'S HOST WAS FOUND BY A DOCUMENT-WIDE ID LOOKUP** — `document.getElementById("sat-popup-map")` returns the FIRST element with that id in the DOCUMENT, and **the popup pane can hold more than one satellite popup at once**: the one that is **fading out** (Leaflet removes a closed popup's container **200 ms AFTER** the close) and any ghost the auto-restore re-opened. **TWO CONSEQUENCES, AND THE SECOND IS THE WORSE ONE.** (1) Leaflet **refuses to initialise a container that already carries a map**, so the wrong element is an **uncaught error in the reader's console** — and it was uncaught because the build runs in a **timer**, outside the `try/catch`. (2) When it DID initialise the wrong element, **the popup the reader was LOOKING AT showed an empty grey box where the satellite should be**: measured in Firefox (Playwright), a second satellite popup opened inside the 200 ms fade put the map in the **OLD, fading** popup — the visible host had **no `_leaflet_id` and no children at all**. **THE FIX (app.js, `openSatellitePopup`):** the host is now the popup's **OWN** element (`popup.getElement().querySelector(".sat-popup-map")`); an element that still carries a `_leaflet_id` — an **orphaned** map, because Leaflet re-sets a popup's content as innerHTML, which destroys the element the map was built on while the map keeps fetching tiles for ever — is **replaced with a fresh one** before the map is built; the **pending build is cancelled when the popup closes**; the popup's **`contentupdate`** event **moves the map to the new element**; and a failure is **logged** (`XLog.warn`), never thrown at the reader. **MEASURED AFTER, live, in BOTH engines:** one open → the visible host carries a map with **4 Esri tiles loaded**; **two opens 60 ms apart** (inside the fade) → the visible host still has the map (it did not before); **ten rapid opens** → one visible popup, working map, **0 errors**. Pinned by a new test in `interaction-prefs.bun.test.js` (it asserts on **comment-stripped** code — the fix note quotes the broken call — and forbids the id lookup from coming back). |
| ✖ **The "⚡ Live data is unavailable" banner could not be closed at all** | ✅ shipped (11-10) | Owner ask: *"can we correct it so we can also close it with an X when this message pops up?"* — the banner that says *"Live data is unavailable — the map and any overlays you have downloaded still work. Pins and search reconnect automatically."* **IT IS A SEPARATE NOTICE FROM THE TILE ONE**, and that is why it had no X: the "Map imagery isn't loading" banner is raised by `offline.js` (and has carried a dismiss button since 11-04), while **this one is raised by `app.js`'s `ApiHealth`**, which polls `/api/health` every 15 s — and it had **no way to be closed at all**, only a "Retry connection" button. **IT NOW CARRIES THE HOUSE `✕`** — the same `.xyzo-notice-dismiss` class, so it is the same 28 px target, the same **44 px on a coarse pointer**, the same focus ring and the same look as the tile notice's X (**one class, one look, two notices**). **AND THE DISMISSAL FOLLOWS THE SAME RULE, because the health check would otherwise put the banner back within 15 s:** remembered for the **session** under **its own key** (`xyzo.apiDownDismissed` — closing "live data is unavailable" must not close "the imagery isn't loading"), **not cleared by the X's own click**, and **forgotten when the situation RESOLVES** (the API answers again) so a genuinely **new** outage warns the reader. **MEASURED END TO END with Playwright** (the API routed to 503): the banner appears with the X (28×28, `aria-label="Dismiss this notice"`); the X closes it; it is **still closed 35 s later** (two more health checks); the API recovers → the dismissal is **forgotten**; a new outage → **the banner warns again**. **0 page errors.** Tests: **2 new** in `offline-notice-dismiss.bun.test.js` (the X exists, and the dismissal is remembered / not cleared by the click / forgotten on recovery). |
| 🌬️ **The wind stopped in the middle of the Pacific — a fixed longitude window was killing the particles** | ✅ fixed (11-10) | Owner report: *"what can we do to 'connect the pacific ocean' wind maps.. i like to see the wind particles working across teh pacific if you look with a visual browser like playwright you will notice that its stops in the middle of the pacific.. notice the rigth side has the wind but the left doesn't?"* — at `#18.9998,-168.2666,5`. **LOOKED AT IT WITH PLAYWRIGHT, AND THE CAUSE WAS A HARD-CODED WINDOW.** The particle guard read **`p.lng < -180 || p.lng > 185`** — but **LEAFLET'S LONGITUDE SPACE IS CONTINUOUS**, and that view's bounds are **west −199.9 … east −136.6**: the particles on the far side of the dateline are *legitimately* at −199. **They were killed every frame** — and `spawn()` picks the next longitude from `map.getBounds()`, so **the replacement died at once too**. The western Pacific was blank. **THE MEASUREMENT SAID IT EXACTLY**: the ink on the canvas was **1,393 samples on the left half against 3,832 on the right** — the left was 36 % of the right, which is the *"right side has the wind and the left doesn't"* the owner saw. **THE FIX: the guard is RELATIVE TO THE VIEW** — `offWorld(p)` asks *"more than a whole turn outside the visible window"*, against `state.viewWest` / `state.viewEast`, refreshed **once per frame** in `step()` (the screen check already recycles everything nearer). **AFTER: left 9,615 / right 9,590 — 100 %**, with 391 particles now alive west of the dateline (before: 35). **CHECKED AROUND THE WORLD**: east of the dateline (114 % — the trade-wind band is genuinely stronger on one side), an ordinary Atlantic view (**0 particles outside the old window, unchanged**), and the whole-world view at zoom 2 (110 %, with 318 particles correctly on the far side of the map) — all still animating, **0 console errors**. The screenshot shows the trades running **across the entire ocean** with the subtropical gyre in the south and Hawaii in the middle. Pinned by **2 new tests** in `wind-layer.bun.test.js` — the fixed window must not come back, and the guard must be measured against the view. |
| 🌊 **The river names are OFF by default — and the SOURCE was studied to find out why they read oddly** | ✅ shipped (11-08) | Owner ask: *"lets view a map like this.. and others with 'river names' and see what we can do using playwright and study the orginal data source not to show any labels if the user doesn't want to see them.. it might already be that way.. so default it without lables"* — with his `#36.3594,-98.1519,6/…rivers-fao-2026@100…/rivers=medium` link. **IT WAS NOT ALREADY THAT WAY: the names were ON.** They are now **OFF by default on BOTH river layers** — the FAO one (which had a switch) and the Natural Earth one (**which had none**, so its names could not be turned off at all; it has a switch and a legend now). The choice is **remembered** (`xyzo.faoRivers.labels` / `xyzo.rivers.labels`), so this is a default and not a removal. **MEASURED live (Playwright):** the owner's URL, a fresh profile → **0 names painted**; the switch → **39 names**, none mangled; the Natural Earth layer → 0 names, and its switch → the real names ("Missouri", "Mississippi", "Ohio", "Arkansas"). **WHAT THE SOURCE SAYS, AND WHY THE DEFAULT HAD TO CHANGE — the classic FAO rivers layer (`rivers_world_47950`, 86,882 features) has NO RIVER NAME.** Its 18 attributes are topology, basin ids and **`maj_name` / `sub_name` — BASIN names**. So the map was printing the name of the *basin* a reach belongs to: **601 of the 5,097 names are compounds** ("Cahokia / Joachim", "Mississippi - Missouri", "Lower Mississippi / Memphis"), and the rest are places ("Gobi Interior"), abbreviations ("Ko", "Mu", "Po") or **Spanish area DESCRIPTIONS** ("Zona de rios en Chaco Boreal", "Pampas Region"). A reader who has not asked for a word should not be given one. **THE STUDY ALSO KILLED MY OWN HYPOTHESIS, WHICH IS THE PART WORTH RECORDING:** the source carries two Strahler fields, and `a_strahler` is the larger in **93.3 %** of the features, so it looked like "the river's order, not the fragment's" — **it is not**: it is the order of the BASIN, and gating on it would admit **5,830 of 5,858** names at zoom 6 (everything) and rank fragments and places as the greatest rivers ("Boumba", "Gulf of Guinea"). **`strahler` is the right field**, and the gate leaves 769 names at zoom 6. **THREE CLEANUPS, PUBLISHED (5,097 → 5,082 names):** the publisher's **mangled accents** (1,546 features carry the UTF-8 of U+FFFD **encoded a second time** — "Ariï¿½ge" for "Ariège"; **verified at the source**, the live WFS sends those bytes, so the character is gone from their data and prints as a plain "?"); the **16 area descriptions** (in Spanish, which is why the English word list never caught them); and the **two-letter abbreviations** ("Ko" is a reach of Lake Chad, "Lom" of the Danube, "Mu" of the Irrawaddy — the parent is published under its own name, so nothing is lost). **AND THE REBUILD EXPOSED A LICENCE BUG:** the builder OVERWRITES the published `meta.json`, and it could not reproduce the **upstream** attribution (the Exhibit B statement the HydroSHEDS licence requires to travel with the metadata) — it had been published once by a builder version that no longer existed, so a rebuild **dropped it** and `data-licences.bun.test.js` failed on the published file. **A licence obligation must survive a rebuild**: the text now lives in the builder, and the fetch script imports it from there — one statement, two places it travels. `BUILD` moved `20261105 → 20261109` (a URL is the cache key). Tests: **2 new** in `fao-rivers-layer.bun.test.js` (the default, the licence, the cleanups) and **1 new** in `river-layer.bun.test.js` (the switch). |
| 🌍 **A first visit now opens on the owner's OWN 15-overlay map** | ✅ shipped (11-08) | Owner ask: *"might be nice to have a default starting map on 'first load' for normal 'fast computer' users something like this.. or if they click [the 🌍 Earth portrait chip]"* — with their link, `#2.1967,16.8750,3/density=max/overlay=wind-gfs@100,basins@100,koppen@100,soil-soilgrids@65,rivers@100,cropland-esa@50,population-density-worldpop-1-km@25,land-cover-esa@60,isobars@100,soil-type-hwsd-v2-2@30,wind-speed-gfs@30,tectonic-faults-usgs@100,nasa-rain@30,etopo@55/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed`. **THE EARTH-PORTRAIT PRESET'S HASH IS NOW THEIRS, VERBATIM** — and since that preset *is* the first-visit showcase (`COOL_ID.high`), **a bare `xyzo.org` opens on exactly that map**. **IT IS STILL ONE LINE OF CODE**: `map-presets.js`'s `portrait` entry, with `COOL_ID` right below it choosing it by tier. What changed against the 2026-11-04 version: the **geology** and the **2014 ocean currents** are GONE (a stale altimetry field has no business opening a showcase map); the **soil TYPE (HWSD)**, the **relief (ETOPO)** and the **tectonic FAULTS** came in, with the wind **SPEED** field under the animation; the **isobars** went from 1 hPa to **0.25 hPa off GFS** (the finest the chip ladder offers — 417 levels, 2,798 lines, 119,734 vertices in the first viewport); and the heavy washes came UP (Köppen 20 → 100, soil 20 → 65, land cover 15 → 60) because this map is read as a **portrait of the land**, not as a wind chart. **MEASURED ON THE LIVE SITE (Playwright, a fresh profile = a first visit):** the page opens at **2.109 N, 16.875 E, zoom 3**, the hash comes back as their link, **all fourteen overlay rows plus the isobar row are ticked**, `isoStep 0.25 / colour pressure / source gfs`, `wind particles / speed` with the grid in and **1,234 particles**, and the wind canvas **changes between two reads 2 s apart** (2,261 → 2,283 lit samples). **0 console errors.** The 🌍 chip applies the same fifteen layers and the same three style settings and **keeps the reader's camera** (the 11-01 rule: *"keep the perspective and zoom level and just update the selections"*) — a chip click is a layer swap, not a flight. **ONE TEST HAD A HOLE, AND THE OWNER'S OWN LINK FOUND IT:** `map-presets.bun.test.js`'s "every preset slug resolves DETERMINISTICALLY" scan matched only `LAYER_NAME: "…"` and not `const LAYER_NAME = "…"`, so **`soil-type-hwsd-v2-2` — a slug that resolves fine in the browser — failed the gate** (the same hole `panel-parity.bun.test.js` had on 11-05). The scan now accepts both spellings. **THE FIRST VISIT NOW COSTS 25.8 MB / 395 requests** (measured with the resource-timing buffer raised — the default 250-entry buffer DROPS the rest and under-reports by half), of which **10.5 MB is the ETOPO relief probe grid** and 2.9 MB the wind grid: see **Q-N0**, which is where that cost is tracked. Token `202611090222` via `bump_asset_token.sh` (the per-file stamp) and `bump_frontend.sh` (app.js's comment). Tests: **1556 pass / 0 fail** (85 files). |
| 🧯 **Firefox: "A ServiceWorker intercepted the request and encountered an unexpected error" — a full cache was failing live requests** | ✅ fixed (11-08) | Owner, on **Firefox 157** after a plain reload (hard refresh worked): `Failed to load 'https://xyzo.org/api/health'. … sw.js:292:11`, the Live Feed banner up, `NS_BINDING_ABORTED` / "blocked", and *"after about 2 min it will finally load correctly"*. **`sw.js:292` is `event.respondWith(networkFirst(request, API_CACHE))`** — so the promise handed to `respondWith` was REJECTING for a response **the network had already produced** (their headers show `x-response-time: 1ms`). **TWO SHAPES did it, both from a spent Cache Storage quota:** `const cache = await caches.open(cacheName)` sat **outside any try** in both handlers, and `await cache.put(…)` inside the try fell through to `throw err` when nothing was cached — so a *caching* failure became a *request* failure. `DATA_CACHE` was the cache spending the quota (unbounded: every `/data` tile **plus** the multi-MB probe grids — soil alone 12.9 MB). Hard refresh "fixed" it only because it bypasses the worker. **FIX:** every cache operation is now guarded and a cache failure **degrades to "no offline copy" instead of failing the fetch** — `caches.open`, `cache.match`, `cache.put`/`trim` in both `cacheFirst` and `networkFirst` — while a genuine **network** error still propagates (the asset really is missing, and swallowing it would hand the page a body it cannot use). **`DATA_CACHE` is now bounded at `DATA_LIMIT = 2000`**, oldest-first, so the cache that was spending the quota is capped; a count cannot express a *byte* budget (Q-N25), which is exactly why the guards are the load-bearing half. **TESTED IN BOTH ENGINES — Chromium and Firefox**, each doing a cold load **then a reload with the worker active** (the failing sequence): **350/350 tiles, 0 broken, wind animating, `/api/health` 200 on every request, and NO "ServiceWorker unexpected error" in either.** Pinned by a new `offline-layer` test asserting the unguarded `caches.open` form is gone and that **every `cache.put` sits inside a try** — so a future edit cannot quietly re-open this. Tests: **1544 pass / 0 fail**. |
| 🕳️ **The tile mirror's rate limit punched holes in the basemap** | ✅ fixed (11-08) | Found while checking the owner's *"the map doesn't show"*: the mirror limited **every** request to 600/min per IP — but one view of their 15-overlay link is **~184 mirrored tiles**, and a minute of ordinary panning produced **500**. **MEASURED: 8 pans → 24 × HTTP 429 → 24 BROKEN tiles** (662 tiles requested, 385 loaded, 24 with a JSON error body where an image should be), which is exactly what a reader reports as "no map". **TWO FIXES, and the first is the one that matters:** **(1) a cache hit never reaches the limiter at all** — it is a local disk read that touches no origin and costs nothing, so it is answered before the rate check; **(2)** the limit now applies only to **real upstream fetches**, raised to **3000/min**, and when it does fire it answers **the last good copy if we have one, else the transparent placeholder** — never a JSON body, because a 429 on an `<img>` is a broken tile the browser logs and Leaflet never retries, so the hole stays until the reader happens to pan again. **AFTER: 8 pans → 404 requests, 0 non-200, 0 broken tiles.** Tests: **1543 pass / 0 fail** + **8** `tile-mirror` API tests. |
| 🌬️ **"The wind only shows after a hard refresh" — a half-written grid.bin was being cached for ever** | ✅ fixed (11-08) | Owner: *"im still seeing the wind not show up unless i do a hard refresh… sometimes i type the full url then the second time i type xyzo.org"*. **THE WORKER WAS WRITING THE FILE IN TWO STEPS.** `windmap.write_grid` did `u16.tofile(path)` — and `numpy.tofile` opens **`"wb"`, which TRUNCATES** — then opened it `"ab"` to append `v`. So for the whole duration of a ~4 MB write, **any concurrent reader saw a file of exactly `n*2` bytes: precisely HALF**, and always the same wrong size. The client's check (`buf.byteLength !== n * 4`) then threw, `onAdd`'s `.catch` set **`state.enabled = false`**, and the wind never started. **AND IT STUCK — which is why only a hard refresh ever fixed it.** A truncated response is an ordinary 200 with the right headers, so the browser cached it **under an UNVERSIONED URL** (`/data/wind/grid.bin`, no `?v=`), and the service worker's `cacheFirst(DATA_CACHE)` cached it too: every later visit was served the same half file, from cache, forever. The only thing that produced a good copy was bypassing the caches — exactly what a hard refresh does. **FIX 1 — THE CLIENT (this is what repairs browsers already broken):** `grid.bin?v=<built>`, where `built` comes from `meta.json` — and `meta.json` is the one `.json` under `/data/`, so it is fetched **NETWORK-first even through the service worker**, i.e. it is always current. A new publish is a new URL, so the half-file at the old one can **never be asked for again** — no cache clear, no hard refresh, fixed on the next visit. On top of that a short read at the *current* version is retried **once with `cache: "reload"`** (every cache bypassed) before the client believes it. **FIX 2 — THE WORKER:** `write_grid` now writes a sibling temp file and `os.replace()`s it — atomic within a filesystem, so a reader sees the old complete file or the new one. **`tempmap.write_grid` had the identical bug** and its client throws the identical way (`grid is N values, expected M`), so it got the same fix. **MEASURED: control =1 request `grid.bin?v=2026-11-08T03%3A45%3A02Z` → 4,152,960 bytes → animating; with the FIRST response forced to exactly half the file →2 requests, full grid, animating, no hard refresh**; and on production with no interception → `meta.json` then the versioned grid, **3086 particles at q=1, 231,473 lit pixels, moving, 0 errors**. The one test mock that matched `endsWith("grid.bin")` now matches the path, because the query string IS the version. **The same non-atomic write exists in seven other builders — see Q-N26.** Tests: **1543 pass / 0 fail**. |
| 🌊 **The currents audit's "a LINK with the layer on" was a FALSE PASS** | ✅ fixed (11-08) | Found while re-running `scripts/ocean_current_audit.py` after the default map changed. The scenario did `pg.goto(FLAT)` and then `pg.goto(LINK)` — and **that is a HASH-ONLY navigation: the same document**, so the boot path does **not** run again and the app's own `hashchange` handler only moves the camera (it cannot re-apply the overlay list, because the app rewrites the hash on every pan and every layer toggle — re-applying there would fight the reader's own toggles). The scenario was therefore measuring **the previous preset's layers**, not the link's: the old Earth portrait carried `ocean-currents-live@100`, so the currents it found were already on. It only shows up now, because the new default map does **not** carry them. **THE SCENARIO NOW OPENS THE LINK IN A FRESH PAGE** — what a reader does — and the verdict is the honest one: **the link switches the currents on** (`enabled true`, grid in, **1,400 particles**, canvas advancing, **0 console errors**). **NOTHING TO FIX IN `app.js`:** a link is applied at BOOT, and the same-document case is a deliberate limit, not a defect. |
| 🗄️ **Every remote tile source is now served from our own disk — cached, and revalidated against the origin** | ✅ shipped (11-08) | Owner: *"lets do our best to try and have all the data locally so we can serve it and check that the data is fresh with the remote servers — we don't want to save it permanently, we just want to cache it so we have live data ready when people need it. for all types of maps."* **NEW `api/src/routes/tileMirror.ts` → `GET /api/tile/mirror/:mapId/:z/:x/:y`**, holding **11 sources**: Esri ×6 (imagery, street, dark, light, NatGeo, terrain), OpenStreetMap, OpenTopoMap, Macrostrat, and the two FAO WMTS layers (WorldPop, HWSD). **FRESHNESS, exactly as asked — cache, not archive:** inside a source's TTL the copy is served untouched; past it the origin is asked with `If-Modified-Since` — **304 keeps the bytes and resets the clock, 200 replaces them**, and an origin that is down answers with the **STALE copy rather than a hole** (`X-Tile-Mirror: hit / miss / revalidated / refreshed / stale / placeholder` says which). A sweeper runs hourly: anything older than **45 days** is deleted and the tree is capped at **3 GB, evicted oldest-first**. TTLs are per source because they are different kinds of thing — Esri imagery and the street maps **1 day**, OSM 1, OpenTopo 2, FAO 7, **Macrostrat 30** (the geology has not moved in 100 My). **THREE TRAPS, EACH FOUND BY BUILDING IT:** **(1) THE URL CARRIES NO FILE EXTENSION.** Caddy's `@staticAssets` block matches `path *.png *.jpg …` with no `/api/` exclusion and stamps it `max-age=31536000, immutable` — a mirrored `/api/tile/mirror/esri/5/3/2.png` would be pinned in the browser for a YEAR, which is the precise opposite of revalidation. The NASA and FAO-river proxies already use extension-less paths for this reason; browsers sniff images regardless. Verified after deploy: the response comes back `Cache-Control: public, max-age=3600`, never `immutable`. **(2) ROUTE ORDER.** `/tile/mirror/:mapId/:z/:x/:y` is the same six-segment shape as the NASA proxy's `/tile/:dataset/:date/:z/:y/:x` (`dataset="mirror"`), so it is registered **first** — the same lesson the FAO-river route already taught. **(3) THE SERVICE WORKER WOULD HAVE FLOODED ITSELF.** Mirrored tiles are same-origin `/api/…`, which `sw.js` sent to `API_CACHE` — a cache with **no limit**, and one view of a 15-overlay link is ~500 tiles (the Q-N20 quota blowout). They now branch to the **bounded `TILE_CACHE`**, network-first so the mirror stays the freshness authority, and **placeholders are never cached** (a blank tile pinned forever is a hole that outlives the origin having the real tile). **WIRED: all 8 base layers, geology, WorldPop, HWSD, and the globe's Esri basemap + Macrostrat** — attribution strings untouched, because who the picture is FROM has not changed. **MEASURED ON THE OWNER'S LINK: 184 mirrored requests, 0 direct remote requests** (Esri46, WorldPop46, HWSD46, Macrostrat46), 300/300 tiles, **0 console errors, 0 HTTP ≥ 400**; the globe the same (**92 mirrored, 0 direct**). **FRESHNESS PROVEN, not asserted:** a cached tile backdated 3 days past its 1-day TTL → `x-tile-mirror: refreshed; 200` and the file's mtime rewritten. **GUARD RAILS:** unknown `mapId` → 404; past a source's `maxZoom` → **200 + placeholder** (never a 404, which is a console line a reader cannot act on); out-of-range or non-integer z/x/y → 400. A non-image200 (FAO answers `{"detail":"Not Found"}` with a 200) is treated as a failed fetch and **never written to disk**. **LICENCE**: `docs/DATA_LICENSES.md` Esri row moved from **REVIEW** to **OK — cache only**, recording that this is request-driven with a TTL and no pre-download, which is the line between a cache and the bulk redistribution Esri's terms exclude. Tests: **1543 pass / 0 fail** (the WMTS-fact tests in `population-layer` and `hwsd-layer` moved their assertions to `tileMirror.ts`, where the URLs now live — a test pointed at the wrong file passes forever), `validate-api.sh` ✅. |
| 📡 **"Is Esri slow, and can we serve the data ourselves?" — Esri was the FASTEST host; the straggler was our own hidden Live Feed** | ✅ fixed (11-07) | Owner: *"we see that its very slow with server.arcgisonline.com — can we focus on using sources we can download and serve directly if the server is too slow? we want to serve as much data as we can in case the remote site goes down… lets time it both locally and remotely… also if one part of the code isn't loading fast we should focus on loading the other parts that are"*. **TIMED, RAW, PER HOST (sequential, from this box):** Esri **TTFB 165 ms / total 169 ms** (HTTP/1.1), ours **137 ms** (h2), FAO **237 ms** (h2), Macrostrat **287 ms** and **111 KB a tile** (h2). **AT PAGE LEVEL (46–92 tiles each): Esri finished ALL 46 tiles in 1.2 s — the fastest remote host on the page**; FAO 2.9 s, ours 6.4 s, Macrostrat 7.2 s (slowest). **THE PREMISE WAS WRONG, AND SAYING SO IS THE POINT**: under DevTools a tile's *Time* includes queueing behind ~580 other requests, so Esri looked slow while actually being first. **SIMULATED REMOTE (CDP, 150 ms RTT / 8 Mbps): all tiles 7.3 s → 42 s**; at 300 ms / 1.5 Mbps the picture never completed inside the window. The dominant term is **request COUNT (583)**, not any one host — every request pays the RTT. **THE ACTUAL STRAGGLER WAS OURS:** `/api/image-proxy` — **16 requests starting at 6 s, each taking 17–18 s in one run and holding the network open until 24 s**, plus `/api/health` stalling to **12 s and once to a 30 s timeout** during heavy loads (a bare map polls it at 143–477 ms, 0 slow — so it was load, not the API). Those 16 were the **Live Feed's article thumbnails, fetched while the panel is `collapsed` at `opacity: 0`**. **`loading="lazy"` could not stop it: Chrome's lazy threshold is a DISTANCE (~1,250 px), and the panel is parked at `translateX(-320px)` — well inside it.** `display:none` *does* stop it (the Explore panel's images never load while it is `hidden`); a 320 px translate does not. **THE FIX**: feed `<img>` tags emit `data-src` while the panel is closed and become real requests in `setPanelCollapsed(false)` — the ONE path that opens it, so nothing can be left blank; a re-render while open emits `src` directly. **MEASURED AFTER: 0 image-proxy requests while closed (was 16)**, 23 deferred, opening the panel hydrates all 23 and fetches 16, **0 console errors, 0 HTTP ≥ 400**, wind/isobars/300 tiles unaffected. **RESILIENCE ALREADY EXISTS AND IS NOW PROVEN**: `sw.js`'s `TILE_CACHE` holds the remote tiles — my first check reported "no tile cache" only because a same-URL `goto` does not navigate, so the SW never got to intercept; with a real reload it holds **184 remote tiles (46 Esri + 92 FAO + 46 Macrostrat)**, and with **the entire network forced down the map renders in full**: 300/300 tiles loaded, 0 broken, the tile element measuring **668 unique colours against 669 online** and the full page 12,972. **SELF-HOSTING IS LICENCE-BLOCKED FOR THE ONE THAT MATTERS MOST**: `docs/DATA_LICENSES.md` records Esri as *"licensed for the basemap use, not for bulk redistribution"* (flagged **REVIEW**) — downloading and re-serving the imagery is not permitted, so the SW cache (what readers actually viewed) is the correct ceiling. Macrostrat (CC BY 4.0) and the FAO services (CC BY 4.0) *could* be mirrored, but the SW already serves repeat visits locally, so a server-side proxy would buy first-visit latency only. **TOKEN TRAP, found by the tests**: stamping `app.js` alone with `bump_asset_token.sh` breaks two sync tests — `app.js` must move **with** `climate-layer.js` and with the lazy-chunk URLs written *inside* app.js, so `bump_frontend.sh` is the right tool whenever app.js changes. |
| 🗜️ **"Why is it taking so long to load the image" — 30 MB of that page's 43 MB were `.bin` grids going over the wire uncompressed** | ✅ fixed (11-07) | Owner: *"why is it taking so long to load the image for `#19.0621,1.2305,3/density=max/overlay=…15 overlays…/iso=0.1…`"*. **MEASURED FIRST** (Chrome's resource-timing buffer holds **250 entries and drops the rest**, which is why an earlier profile of this very link reported "250 requests, 4.3 MB" — the truth is **572 requests, 43.5 MB**; raise it with `performance.setResourceTimingBufferSize()` before you believe any of these numbers): that link pulls **43.5 MB across 572 requests and finishes its picture at 7.7 s**, against a bare map at the same spot's **2.3 MB / 130 requests / 1.2–1.5 s**. **THE SINGLE BIGGEST ITEM WAS A KNOWN ISSUE: Q-N21 — Caddy does not compress `.bin`.** `encode` only compresses the Content-Types on its default list, and `file_server` answers `application/octet-stream`, which is not on it — so soil's `grid.bin` went out as **12,960,000 bytes where gzip gets 479,000 (27×)**, cropland's `grid.bin`/`class.bin` as 6.48 MB each (16–22×), and across `public_html/data` **465 MB → 74 MB**. **THE OBVIOUS FIX IS A TRAP, AND IT IS REPRODUCED HERE**: an `encode { match { … } }` block **REPLACES** the default matcher set rather than adding to it — on a throwaway instance, naming `application/octet-stream` in one turned compression **OFF for `.js` and `.css` too** (both lost their gzip), and the response-header form (`header >Content-Type …`) matched nothing at all. What works is to change the **type the existing `encode` already sees**: `@bins path *.bin` + `header @bins Content-Type application/json`, with `caddy adapt` confirming the handler order is `headers → encode → file_server`. **The Content-Type is a deliberate lie and the Caddyfile says so in full**; nothing reads it (the client does `r.arrayBuffer()`, `sw.js` only looks for `text/event-stream`). `caddy validate` → `caddy reload` (graceful, admin API), backup at `/tmp/opencode/Caddyfile.bak-20261107`. **MEASURED AFTER, same link, same script: 43,542 → 18,244 KB (−58 %), network quiet 7,230 → 6,301 ms, all tiles 7,732 → 6,722 ms** — soil grid **12,656 → 531 KB**, cropland grid **6,328 → 396 KB**, cropland class **6,328 → 319 KB**, lightning's annual grid **18.7 → 2.8 MB**. Site, `/globe` and `/api/*` all 200, **0 console errors, 0 HTTP ≥ 400**, and the probes still read real values through the new encoding (`Soil groups (WRB) · Leptosols`, `Bare / sparse vegetation · 0% cropland`). **WHAT IS LEFT ON THAT LINK** (all already compressed, so no fix here): the wind grid 2.98 MB (u/v noise barely compresses, 1.3×), `rivers.geojson` 1.9 MB, `basins_major.geojson` 1.5 MB, `cities.10k.json` 1.2 MB (warmed on **every** visit by `city-engine.js`'s idle `scheduleIdle(() => load())`), and the `iso=0.1` isobar response — **2.0 MB on the wire / 5.2 MB decoded, one request taking 3.2 s**, which is the cost of the finest detail step rather than a defect. Also measured and **not** a cause: blocking the probe grids entirely did **not** speed the tiles up here (4,118 ms vs 3,703–4,079 ms baseline) — this box is co-located with the server, so it is latency-bound, not bandwidth-bound; on a remote connection the 26 MB it used to carry would have mattered a great deal. |
| 🌬️ **"Its not showing wind animations" — the last renderer still filling BARE, and a new Playwright test for the cached-revisit you described** | ✅ fixed (11-07) | Owner: *"its not showing wind animations.. i really care about them.. or its very slow on cached websites so for example you load it, move the map, change the navigation or 'style' of the map then load the old page with cache and it won't work — have you tested this scenario with playwright"* **YES: `scripts/wind_cache_check.py` drives exactly that** — six scenarios in Playwright (cold load · the same URL again in the same context · pan + switch the BASEMAP + `reload()` · pan + switch the basemap + navigate to the same URL · pan + switch the basemap + go to `/globe` + `goBack()` (bfcache) · change the wind's own style + reload), each judged by the only verdict that counts: **does the wind pane's CANVAS change between two reads 1.5 s apart**. A layer reporting `enabled: true` with a frozen canvas is the failure this exists to catch. **RESULT: 6/6 animating — the cache scenarios were NOT the bug.** **WHAT WAS: your link pins `wind=particles:speed`, and `particles` was the last of the four renderers still filling bare dots** — `r = 1.5 + 1.1·speed`, a 3–5 px circle, one `ctx.fill()`, **no halo at all**, while the streamlines and the flow both stroke a near-black ring under their core. **MEASURED ON YOUR EXACT LINK (15 overlays, `iso=0.1`): the animation ran perfectly — 1,234 particles, canvas changing every frame — and painted 1.47 % of the screen**, against 9.30 % for streamlines and 47.9 % for flow. Same defect, same cause and same fix as the streaks' *"i click on it and i don't see anything"*: **a bloom in the mark's own colour can only make the ground brighter around it, which is the one thing that cannot help over a busy basemap.** `renderParticles` now does the same three passes as the streaks (dark halo → bloom → core) with named constants (`PARTICLE_R_MIN` / `PARTICLE_R_SPAN` / `PARTICLE_HALO_PX`, dot 1.9–3.4 px, ring 4.6 px so a mark reads ~7 px). **MEASURED AFTER: the canvas holds 20,213 → 88,891 lit pixels (1.56 % → 6.86 %), of which 16,801 are the dark halo**, and the composite screenshot now shows the dots over all fifteen overlays where before it showed none. **THE 3D GLOBE HAD THE SAME DEFECT** — `globe-wind.js` (the one engine serving BOTH the wind and the ocean currents) stroked bare 1–2.6 px streaks: **2.57 % → 6.02 %** of its canvas, path built once and stroked twice so the per-particle setup does not double. **AND THE ANIMATION IS NOT WHAT MAKES IT FEEL SLOW**: measured on your link, **8 fps with the wind ON and 8 fps with it OFF** — the other fourteen overlays own the frame budget (and headless has no GPU; with them hidden the wind alone runs **49 fps**). What IS slow is the **boot**: `_xyzoMap` lands 4.2 s after navigation on that link (1.3–3.3 s for wind-only) and the wind's first animated frame comes **0.2–7.6 s after that** — see Q-N23. Tests: `wind-styles.bun.test.js` gains a halo gate over all three animated renderers, **mutation-checked** (swap the particles' halo for red → fails). |
| 🔗 **A shared link did not survive the trip between 2D and 3D — five ported overlays, three settings, and every opacity was a lie** | ✅ fixed (11-07) | Owner: check *this* link on **both** views — `#72.3024,12.6563,4/density=max/overlay=wind-gfs@100,…,wind-speed-gfs@30,isobars@100/iso=0.1:pressure/isoSrc=gfs/wind=particles:speed/rivers=medium` — and then *"check all the others that all the possible likely settings work for both 3d and 2d maps"*. **MEASURED FIRST, with a new round-trip audit (`scripts/shared_link_parity.py`: open flat → follow the globe button → open "Back to the map" → diff): 9 of the 15 overlays and 3 of the settings were gone by the time the reader came home.** **(1) FIVE OVERLAYS THE GLOBE CAN DRAW WERE DROPPED**, because the two sides name them differently and only six aliases existed: the flat map's `getLayerSlug()` writes `wind-gfs / wind-speed-gfs / ocean-currents-live / earthquakes-usgs / tectonic-faults-usgs`, the globe keys them `wind / wind-speed / ocean-current / earthquakes / faults`. The owner's link lost **wind, wind speed and ocean currents in one hop**. **THE CHECK THAT WAS SUPPOSED TO CATCH THIS COULD NOT FAIL**: it round-tripped the *globe's* key (`key → flat || key → key`), a tautology whenever there is no alias. `panel-parity.bun.test.js` now extracts the **shipped** `getLayerSlug()` out of app.js and asks what the flat map would really call each globe label — **mutation-checked** (delete one alias → 2 tests fail). **(2) THE GLOBE DESTROYED THE FLAT MAP'S SETTINGS.** `applyGlobeHash()` rebuilds `location.hash` from the layers the globe drew, and "Back to the map" is built from that — so `density=max`, `wind=particles:speed` and `rivers=medium` were **gone after one visit to the globe**, all three visible in that very link. The globe cannot honour them (it has no such controls); it now **carries** them (`flatOnlyParts()`), because a round trip must not amputate the reader's own map. **(3) THE THREE OVERLAYS THE GLOBE CANNOT DRAW AT ALL** (WorldPop population, HWSD soil type, FAO 2026 rivers — hotlinked WMS/WMTS with no XYZ template MapLibre can consume) were **silently dropped on the way home**, so a 2D → 3D → 2D trip returned 12 of 15. `registerGlobeKeys()` lets globe.js declare what it can draw, and `flatHref(globeHash, incomingHash)` puts the rest back — **in the back link only**, so the globe's own URL stays honest about what it is showing, and a layer the reader deliberately switched off there is not resurrected. **(4) AND EVERY OPACITY WAS A LIE IN THE OTHER DIRECTION.** `OverlayOpacity.get()` — whose only caller is `getMapHash()` — read the **stored preference** and ignored `VIEW_OVERRIDES`, the value `applyView()` records for a link. Measured across **20 overlays at 37 %**: the map drew 37 % and the URL said **100 %** for basins, rivers, magnetic, ocean currents, language regions, earthquakes and faults — so re-sharing your own link silently reset the opacity, in both views (the globe reads the same `slug@pct`). `get()` now resolves **view override → stored → default**, the same order the slider mount already used; the reader moving a slider still ends the override. **MEASURED AFTER: `shared_link_parity` 0 lost both ways on the owner's link — all 15 overlays home, all three settings, `iso=0.1:pressure`, `isoSrc=gfs`, position — and 0 lost on a second link exercising `time/base/search/density/wind/rivers`; `overlay_opacity_probe` 0 of 20 wrong; `globe_handoff_check` 2/6 → 6/6; `globe_audit` 19/21 → 21/21** (its two "failures" were the audit's own blind spot: `wind` matched the speed field's `wind-speed-*` layers by prefix, and `ocean-current` is a canvas animation rather than a MapLibre layer — `globe_wind_audit.py` confirms both animations run). **NEW TOOLS:** `scripts/shared_link_parity.py` (whole-link round trip, bucketed by what was lost) and `scripts/overlay_opacity_probe.py` (link → map → URL at one deliberately odd opacity). |
| 🕐 **The 15-minute poll was re-downloading and re-writing the weather grids every 15 minutes** | ✅ fixed (11-06) | Found while confirming the timer fix above: `journalctl` for `xyzo-tempmap` showed ticks at 23:14, **23:29 and 23:44 all fetching, decoding and REWRITING** `grid.bin` (2,028 KB), `meta.json` and the 1° pair for the **same cycle** (`20261107 00Z`) — and **zero** `already published` lines. **THE NO-OP GUARD WAS DEAD CODE.** `write_meta` publishes the product **PREFIXED** (`"product": f"gfs.{product}"` → `gfs.0p25`), while the guard compared the bare `PRODUCT` constant (`0p25`): the `run_time` half matched, the **product half could never match**, so `A and B` was always false. Wind was identical and worse — over 70 minutes **zero** skip lines and **sixteen** writes, every tick decoding both components and rewriting **4,056 KB**. It had shipped unnoticed because at a 6-hour cadence a tick usually *did* have a new cycle, so the dead half rarely mattered; moving to 15 minutes turned it into a fetch-and-rewrite of ~6 MB **96 times a day**. **THE FIX IS ONE SOURCE OF TRUTH:** `published_product(suffix)` now formats the string and **both** the writer and the guard call it (`PUBLISHED_PRODUCT = published_product(PRODUCT)`), so the two cannot drift apart again — four guard sites across `tempmap.py` and `windmap.py`, plus the two writers. **The isobar worker did NOT have the bug**: it compares the stored `run_time` **and** `ISO_INTERVAL_HPA` (a number) out of PostGIS, never a product string. **MEASURED AFTER:** the next tick logged `analysis … already published — skipping the fetch` and wrote nothing. Tests: **4 new** (`TestNoOpProductGuard` in `test_tempmap.py` and `test_windmap.py`) — each does a real round-trip through `write_meta` into a temp file and asserts the published value equals what the guard compares, then pins the guard sites in the source; **72 pass** across the two files. |
| 🟫 **The soil-type key hung OUTSIDE the layers panel — visible while the panel was closed** | ✅ fixed (11-06) | Owner: *"i thought we didn't want the OTHER popup for soil we need that in the main leaflet-control area.. its kinda showing up on the side when it shouldn't"*. **MEASURED with Playwright on his own URL**: `mountLegend()` called `list.insertAdjacentElement("afterend", box)`, which puts the key **after the `<section class="leaflet-control-layers-list">`** — i.e. straight into `.leaflet-control-layers`, OUTSIDE the element Leaflet hides when the dropdown collapses. So with the panel **closed** (the state every first visit starts in) the section was `display:none` / 0 × 0 while **`#hwsd-legend` rendered 221 × 329 at (1207, 64)**, hanging under the stack button — and with the panel open it sat outside the scroll box (list bottom 843, legend 843 → 1172, against a `scrollHeight` of 5118 that carried on inside the section). Every other key was mounted correctly: `#soil-legend` measured **0 × 0** closed. **THREE ELEMENTS, ONLY ONE OF WHICH IS SAFE TO ADD TO**: `.leaflet-control-layers-overlays` (**Leaflet EMPTIES this** on every layer change), `.leaflet-control-layers-list` (the `<section>` — persists *and* is what collapses), and `.leaflet-control-layers` (persists, but escapes both the scroll box and the toggle). The fix is **`list.appendChild(box)`** — a child of the section, a sibling of the two lists Leaflet rebuilds — which is what the header comment had always claimed the code did. **AFTER:** no stray direct children of the control (`[]`), nothing visible while collapsed (`[]`), the key inside the section at index 21 of 32, **0 console errors**. Pinned by a rewritten assertion in `hwsd-layer.bun.test.js` that runs on **comment-stripped** code, because the fix note quotes the broken call — the same reason that file already strips comments before asserting on the catalogue's broken values. |
| 🌬️ **The wind drew fine and still read as "nothing" — the streaks had no CONTRAST** | ✅ fixed (11-06) | Owner report: *"are you sure the wind animation is working? i click on it doent see anything!!???"*. **IT WAS WORKING — measured at his own coordinates** (`#46.73,-117,7`, the lat/lng carried by his own Live-Feed stream URL): `enabled true`, style `streamlines`, **1,234 particles**, rAF advancing (frame id 154 → 393), canvas 1440×900 at `windPane` z379, opacity 0.95, and **228,554 pixels changing per 400 ms**. What was missing was **CONTRAST**: over brown-green satellite terrain a pale cyan hairline has nothing to separate itself from, and **the bloom was painted in the SAME colour as the core** — so over a bright basemap it can only make the ground around the line brighter, which is precisely what does not help. **THE FIX IS A THIRD PASS PER BUCKET: a near-black halo (`rgba(8,12,20, 0.5 × alpha)`, 5.4 px) under the bloom and the core** — invisible against the dark satellite basemap the site opens on, an edge on a light one, the same trick as text with a stroke. Thicker and brighter besides: **core 1.15 → 1.6 px**, **bloom 4 → 4.8 px at 0.22 → 0.30 alpha**, and the **core's alpha floor 0.52 → 0.62** (the slow half of the field was drawn at half alpha and vanished first). The **Flow** style got the same three passes — its canvas ages with `destination-out`, so the halo fades with everything else instead of accumulating into a dark sheet; arrows and particles are glyphs and dots and were left alone. **MEASURED, same spot, same viewport, against a map where the wind was NEVER switched on**: wind ink (pixels >16/255 from that baseline) **5.20 % → 6.79 % (+31 %)**, and the 2× screenshot pair shows it directly — thin pale dashes → dark-edged streaks. **AND A MEASUREMENT TRAP FOUND WHILE DOING IT**: the first before/after used "wind off" as the base, which is only valid if off == never-on (it is here — measured `never-on vs after-off = 0.00 %`); any other state left in the base subtracts the very thing being measured and makes a real improvement read as nothing. **THE CHART IS STILL THE BIGGER PICTURE**: at `iso=0.1` the isobars change **26.5 %** of the same screen against the wind's **6.8 %**, and the two are the same shape — so *"I can't see the wind"* with the chart on is still the first thing to ask about (turn the ⛅ isobars off first). Unchanged and already correct: `autoQuality()` still sheds to the 0.4 floor under FPS < 40 (headless lands there by design) and the published ramp is already bright at its low end (`#1d4ed8`, not `#0b1020`). |
| 🧭 **"The map didn't load." — a hard-refresh offer for a dead app** | ✅ shipped (11-06) | Owner ask: *"is there something we can do if we detect the map isn't loading correctly to allow users to do a 'hard refresh'… like a popup that's closable and they can opt out for if needed"*. The top notice already had the ✕, the opt-out and **Reload fresh** — **what was missing was the DETECTION**: it only fired on a dead connection or failing basemap *tiles*, never on **app.js** failing (500, a throw on line 1, a deploy that didn't bump `?v=`), which is precisely the state where a hard refresh is the fix. It is now a **third wording of the same notice** (owner chose "extend the top notice" over a new modal, and "only when the map fails" over the version badge), triggered by **`window._xyzoMap` absent after `DOMContentLoaded` + 2 s** — exact, because app.js is `defer` (DCL ⇒ it ran or failed) and `_xyzoMap` is set at its **top level**, never cleared — plus a fast path on a same-origin parser `<script>` failing, and a **45 s backstop** for a script that never finishes. **THE FIX THAT MADE THE OFFER REAL:** `hardRefresh()` was a module-level function in app.js, so when app.js is what failed, `window.hardRefresh` was undefined and the button degraded to `location.reload()` — which **cannot bypass the `immutable` year-long cache**. It now lives in `offline.js` (index.html line 708, before app.js at 843), app.js calls `window.hardRefresh()`, and a test asserts there is exactly one copy. **MEASURED (Playwright, live site):** healthy load → **no notice in 18 s**; `app.js` blocked → **4.74 s**; `app.js` throws → **5.88 s**; an optional lazy chunk missing → **no notice**; **`app.js` delayed 8 s → no notice**; pressing Reload with app.js dead → **navigates**; `_xyzoMap` appearing later → **gone in < 2 s** (`healBoot`, which also forgets the dismissal); ✕ then `sync()`/reload → **stays gone**. **THE TRAP, found by measuring rather than reading:** `readyState` is already **`"interactive"`** inside a defer script (it flips *before* they run, DCL fires *after*), so the first version scheduled its probe 6 s after **offline.js** instead of after app.js — and on a healthy connection with app.js 8 s late it **raised the notice at 6.8 s over a map that then appeared**. The probe is registered on `DOMContentLoaded` unconditionally now, and a test forbids any `readyState` branch in `watchBoot()`. **A SECOND HOLE, closed the same way:** `sessionStorage` was the only dismissal flag, and `sync()` (from `load` and every `online` event) runs `clearDismissal()` — so a reader who dismissed at 5 s had it erased before the 45 s backstop, which then re-showed the banner; `clearDismissal()` now refuses while a boot dismissal stands, and **only the map appearing forgets it**. Tests: `map-failed-notice.bun.test.js` (**28** new), `hard-refresh.bun.test.js` (re-pointed at offline.js + the script-order assertion), `offline-notice-dismiss.bun.test.js`. Suite **1530 pass / 0 fail (85 files)**. |
| ⛅ **0.10 hPa isobars — and the published lattice had to move to 0.05 for the chip to be true** | ✅ shipped (11-06) | Owner ask: *"lets also add 0.10 hPa isobars.. thanks!"*. **A CHIP MAY NOT CLAIM A STEP THE DATA CANNOT SERVE**: `step=0.1` against a 0.25 hPa table answers with every 0.5 hPa line while the chip says 0.10 — a perfectly well-formed response that lies. 0.1 is not a multiple of 0.25, so the published lattice became the **GCD of the whole ladder, 0.05** (0.1 = 2×0.05, 0.25 = 5×0.05, 0.5 = 10×0.05 …), which makes every chip a subset of ONE published set — `isobar-step.bun.test.js` now asserts that invariant across the worker and the chip list. **THE CHEAPER ALTERNATIVE WAS MEASURED AND REJECTED**: the union of the 0.1 and 0.25 lattices is 12 levels per hPa instead of 20 (40 % less contouring) — rejected because `weather_isobars_build.interval_hpa` is **one number** the no-op guard compares, and a partial lattice cannot be described by it; recording 0.05 for a union would recreate the documented *"finer set never shipped"* trap. **MEASURED on the 2026-11-06 analysis**: the noise claim holds flat all the way down — share of lines shorter than 20° **39.9 % at 0.25, 39.7 % at 0.1, 39.7 % at 0.05** — the cost is perfectly linear (**0.346 / 0.350 / 0.350 s per level**) and the count doubles then scales (**4,531 → 11,266 → 22,544 lines**). **PUBLISHED, BOTH SOURCES AT `interval_hpa = 0.05`: GFS 22,544 lines / 2,385 levels in 11 m 26 s** (it was ~2.7 min at 0.25) **and ECMWF 20,368 / 2,264 in 79 m 53 s** (its 0.1° grid carries 6.25× the cells) — the chip has to be honest for whichever analysis the reader picks, so both went. **THE PROOF IS THE BEFORE/AFTER ON THE LIVE API**: before the ECMWF rebuild, `step=0.1&source=ecmwf` answered `997, 997.5, 998, …` — a perfectly well-formed response at **0.5 hPa spacing while the chip said 0.10** — and after it the same query answers **`997.5, 997.6, 997.7, …`** with **0 levels off the 0.1 lattice**. The GFS ladder over the world now runs **11,152 → 4,486 → 2,250 → 1,139 → 579 → 288 lines** at steps 0.1 / 0.25 / 0.5 / 1 / 2 / 4 (levels 1,078 → 432 → 216 → 108 → 54 → 27) — a proper superset. `python3 -m worker.gfs_verify --field pressure` is green on both sources at the new lattice: **ECMWF p95 0.008 / mean 0.002 (1,110 lines, 540 levels in the box), GFS p95 0.032 / mean 0.005**, with the mirrored-wind control still detected. **THE API'S `limit` DEFAULT WENT 12,000 → 30,000**: a world view at step 0.1 holds **11,152 lines**, so the old ceiling had 7 % of headroom and one extra line anywhere would have **truncated the response with no error**; the globe's own whole-world fetch carried the same 12,000 ceiling and is 30,000 now too. **THE CHIP IS LABELLED `0.10 hPa`** — the name the owner asked for it by — and every other chip's label is byte-identical. **FOUR PRE-EXISTING BUGS FELL OUT OF THE WORK, ALL FIXED**: **(1)** `sanitizeState`'s `Math.round(isoStep)` turned **0.5 into 1** — the wrong step applied — and dropped 0.25 and 0.1 to 0 (segment discarded), so a saved style or a preset could silently open at a detail it did not name; **(2)** the globe's second `iso=` parser (`\d+` only) dropped every fractional step on the way back to the flat map; **(3)** `gfs_verify`'s `int(level_hpa)` made the audit **measure its own truncation** — it collapsed **108 distinct stored levels to 27** and reported p95 **0.752 hPa** on lines that are accurate to **0.026** — and the tolerances had been raised to 1.0 / 0.5 on the strength of those numbers, with the mutation test weakened to a TWO-cell shift to stay outside the inflated band. **THE TOLERANCES ARE BACK AT 0.4 / 0.25 / 0.6 and that test shifts ONE cell again** (a one-row shift measures 0.698 and a one-column 0.491 — both outside 0.4, which is what the tolerance was calibrated for); re-measured at the 0.05 lattice: **GFS p95 0.032 / mean 0.005 / median 0.001, ECMWF p95 0.010**, and `python3 -m worker.gfs_verify --field pressure` is green. **(4)** the `limit` above. **THE STROKE FOLLOWS THE DENSITY ONE TIER LOWER**: 11,152 lines × 0.5 px = 5,576 line-px against the 5,361 that *"paints the map solid"*, so anything over 6,000 lines draws at **0.3 px** — and the 6,000 cut leaves every existing 0.25 view exactly where it was (4,381 lines, still 0.5 px). Measured on the live map, layer switched OFF in the SAME session as the base, pixels changing by more than 96/255: **14.7 % at 0.25, 31.7 % at 0.10 with 0.5 px, 19.4 % at 0.10 with 0.3 px** — the tier costs **39 % of the heavy view's ink** and lands at 1.3× the 0.25 view instead of 2.2×, with **the same lines on the map**. Payload at step 0.1, whole world: **11,152 items / 6.6 MB raw / 2.44 MB gzipped** (0.25: 4,486 / 987 KB gz). Tests: `isobar-step.bun.test.js` (**30**), `isobar-layer.bun.test.js` (**27**), `map-presets.bun.test.js` (**46**, incl. a fractional-step round trip), `api/tests/weather-isobars.test.ts` (**11**, incl. lattice discrimination), `worker/tests/test_isobars.py` (**48**), `test_gfs_verify*` (**40**); suite **1509 pass / 0 fail**. |
| 🌊 **The rivers are ours now — we downloaded the network and render the tiles ourselves** | ✅ shipped (11-06) | Owner: *"can we legally download the rivers and serve them up ourselves if its too slow or not always working?"* — and then *"well lets try and see what we can do"*. **YES — AND IT IS DONE.** Two scripts, and the licence is on file. **`scripts/river_network_fetch.py`** pages the whole 2026 edition out of the publisher's WFS into `data/rivers_fao_2026/` (gitignored, **outside the web root** — the upstream licence does not permit the data to be distributed as a stand-alone product, so it is the SOURCE for a rendered layer and never a download). **`scripts/river_tiles_build.py`** then renders a **static PNG pyramid** from that copy — our own colours, our own widths, the same rules the published SLD uses — into `public_html/data/rivers/fao/tiles/<level>/<z>/<x>/<y>.png`. **Below z5 the publisher is not involved at all** (z0-z4 — 1,364 tiles, 114 MB); above it, the caching proxy still answers. **THE SPLIT IS MEASURED, NOT GUESSED:** the publisher takes **25-48 s a tile at z1-z2** (the world views — the ones people share) and ~2 s above z3. **MEASURED: the world view arrives in 0.71 s from our own disk (18 tiles), a country-sized z4 view in 1.63 s (28 tiles) and a zoomed-in z5 view in 2.9 s once the proxy's disk cache has it (18 s for the very first reader of an area)** — where the publisher wanted a minute-plus. **THE COPY IS THE WHOLE NETWORK: 8,477,883 reaches in 212 pages, 654 MB, 95 minutes** — and it reproduces the publisher's own counts exactly (**273,191** reaches above 100 m³/s, **857,210** above 10), which is the proof that nothing was missed. **THREE THINGS THE BUILD FOUND THE HARD WAY.** **THE WFS ONLY PAGES WITH A STABLE SORT** — `startIndex` without `sortBy` throws a server-side `IOException`, and the page cap is 40,000. **THE IDS ARE ORDERED BY REGION, NOT BY GEOGRAPHY** — the first 920,000 reaches of the fetch are **North Africa and nothing else**, so a pyramid built from a half-finished fetch is a picture of one continent and would have looked plausible. And **THE TILE'S NORTH EDGE IS THE LARGER NORTHING** — in EPSG:3857 y grows northward while the slippy row index grows southward, and getting it the wrong way round **flips the tile vertically**; the pixel overlap against the publisher's own rendering of the same ground collapsed to **6 %**. The fix is checked the only way it can be: **our tile and the publisher's tile for the same square are now 98 % pixel-identical** ✓. **AND THEN THE READER SAID *\"THE RIVERS LOOK LIKE THEY ARE NOT PLACED CORRECTLY\"* — AND THEY WERE RIGHT, FOR A FOURTH REASON.** **LEAFLET'S `tileSize: 512` PUTS THE TILE COORDINATES ON A 512-px GRID**, while our pyramid and the publisher are both cut on the standard 256-px grid — so every tile was fetched from the **north-west quadrant of where it belonged**: a tile the map wanted at longitude 85° came from longitude **-56°**, and the rivers were drawn over the Indian Ocean out of Greenland. **It is the same rule the Macrostrat geology layer records** (Leaflet's CRS scale is fixed at `256·2^z`), and it survives a screenshot because the picture still looks like a plausible river network — just from the wrong continent. **THE FIX IS ONE OPTION: `tileSize` STAYS AT THE DEFAULT 256**, and the sharpness comes from the IMAGE instead (the publisher renders the standard square at 512×512 and the browser downscales it into the slot). **THE STALE TILES WERE THE OTHER HALF**: a `*.png` under `public_html` is served **`immutable` for a year** and the proxy answers with `max-age=604800`, so the misaligned tiles stayed in every reader's cache for a week — **every tile URL now carries a `?v=` build token**, because a URL is the cache key. **AND THE SERVICE WORKER WAS PRINTING AN ERROR ON EVERY VISIT** (`sw.js:232`): it wrapped the Live Feed's `EventSource` in `respondWith`, so every abort became *\"A ServiceWorker intercepted the request and encountered an unexpected error\"*. The stream itself was fine; **the worker must not intercept a stream at all**. **AND THE LICENCE IS RECORDED** (see `docs/DATA_LICENSES.md`): the FAO layer is **CC BY 4.0**, and the upstream HydroSHEDS licence (Appendix A of its Technical Documentation) permits commercial use, requires the Exhibit B attribution and forbids distributing the data as a stand-alone product — which is exactly the shape we are using. **The gap that audit exposed is now closed: the WWF/HydroSHEDS Exhibit B statement and the Lehner et al. (2008) citation travel in the layer's published metadata, and the map names WWF.** |
| 🚪 **Neither control window opens itself on a first visit** | ✅ shipped (11-06) | Owner ask: *"i think its wiser to not start with the two control windows open when someone first visits the website"* — the **Live Feed** panel down the left and the **layers dropdown** at the top-right both opened over the map on every load, so a first-time reader met two windows and a sliver of map. **Both now start CLOSED on every viewport, and the state is not persisted** (the owner's choice when asked: always start clean, one tap to reopen). **The Live Feed**: its markup ships `class="live-panel collapsed"` — so it is closed even **before `app.js` runs** (verified with `app.js` blocked: `opacity: 0`, `translateX(-320px)`, and the **"Live status ›"** pill already showing) — and `setPanelCollapsed(true)` now runs **unconditionally** instead of only under 768 px. **The layers dropdown**: the constructor stays `collapsed: isPhoneViewport()` — that option decides the panel's *semantics*, not its start state: `collapsed: false` (desktop) is what keeps it **sticky once opened** (Leaflet only binds map-click → collapse and mouseleave → collapse when `collapsed: true`, the *"suddenly disappears while you reach for a slider"* bug), while `collapsed: true` (phone) is what gives Leaflet its tap-to-open wiring — and **`layersControl.collapse()` runs in the same synchronous block** as the constructor, so desktop is constructed open (`_initLayout` calls `expand()`) and closed again before anything can paint it. That works because the toggle's `click` handler sits **outside** the `collapsed && …` guard in Leaflet's `_initLayout`, so a `collapsed: false` control still re-expands on a click — the path that already shipped (open → ✕ → click the toggle to reopen). **Verified in a real browser, clean profile, both viewports**: desktop first paint has the live panel at `opacity 0` with the pill visible and the layers panel **not** expanded; the pill opens the feed, `‹` closes it; a **mouse** click on the stack icon expands the layers panel (68 overlay rows, ✕ attaches), a click **on the map leaves it open** (the sticky rule), ✕ closes it, and a **reload comes back closed** (no persistence). Phone: both closed on first paint, tap the toggle to open, **tap outside to close**, the pill opens the feed. **The tour had to learn it**: the live step pointed at `#live-panel`, which while collapsed is `translateX(-100%)` — a real-sized box **off-screen**, so the spotlight would have landed in the margin; it now targets **`["#live-panel-reopen", "#live-panel"]`** (the button is `display:none` when the panel is open, so the list picks whichever has a real size). `scripts/tour_audit.py` → **all green**: every step has text, step 4 now gets a spotlight, the card never covers its control, no console errors. Tests: `markers-off.bun.test.js` (the start-closed pin), `tour.bun.test.js` (the live target list) — suite **1490 pass / 0 fail**. |
| 🌊 **The river network now has a caching proxy — 64 s of streaming became 2 s** | ✅ fixed (11-06) | Owner ask: *"lets try and do that to speed this all up caching"*. The layer was correct but the publisher's WMS is slow, so a screen took **36 requests and was still streaming at 64 s**. **NEW ROUTE `api/src/routes/faoRiversProxy.ts` → `/api/tile/fao-rivers/<level>/{z}/{y}/{x}`**, and it does three things. **(1) THE UPSTREAM URL IS BUILT SERVER-SIDE**, from a whitelist — the level's own filter and the **published** SLD — so the **4.3 KB SLD body and the discharge filter no longer ride in every tile request** the browser makes (the request line was 4.6 KB; it is now ~60 bytes), and the route has **no SSRF surface at all**. **(2) THE TILE IS CACHED ON DISK** (`data/fao_rivers_tiles/<edition>/<level>/<z>/<y>/<x>.png`, gitignored, outside the web root) — so the **second reader of a view is a local file**, not a round trip to a busy public server. The NASA tile proxy's cache is in-memory and dies with the process; this one survives a restart. **(3) A TILE THE PUBLISHER CANNOT PRODUCE ANSWERS 200 WITH A TRANSPARENT PNG**, so the console stays clean. **MEASURED AT THE READER'S OWN URL: 36 requests still streaming at 64 s → the whole screen in ~2 s on every visit after the first, and the first visit is now ours (see the row below).** **THE REQUEST COUNT IS 35, NOT 12, AND THAT IS CORRECT**: the layer is on the **standard 256-px slippy grid** (see the `tileSize` row — a 512-px grid fetches every tile from the wrong quadrant of the world), so a 1400×900 screen needs 35 of them. The publisher's cost does not depend on the output size, so the tiles are still rendered at 512 px and the browser downscales them into the slot — **sharpness is free, the request count is not**. The cache key carries the **edition**, so a new edition of the network is a new picture and not a stale one, and the browser may keep a tile for a week. |
| 🔄 **"Reload fresh" — the hard refresh, offered where a stale map is standing** | ✅ shipped (11-06) | Owner ask: *"we might need to suggest a hard refresh or have that as an option on the page to refresh it"*. **THE BUTTON ALREADY EXISTED** (⚙ → TOOLS → **Hard refresh**, which pulls every script and stylesheet from the network with `cache: "reload"`, drops the service worker and its caches, and reloads — because `*.js` is served `immutable` for a year, so a normal reload CANNOT replace a stale `app.js`). **It was just three clicks deep in a menu nobody opens when the map looks wrong.** The **"Map imagery isn't loading" / "You're offline" banner is exactly where a reader with a stale map is standing**, so the offer is made there: a **"Reload fresh"** button beside the ✕, calling the same `hardRefresh()`. All three wordings carry it — "Map imagery isn't loading…", "You're offline…" and (since 11-06) **"The map didn't load."** — it is a real `<button>` with a title that names the keyboard shortcut, and it sits in the text flow so it never covers the message. |
| 🌬️ **The wind was running perfectly and the reader could not see 60 % of it** | ✅ fixed (11-06) | Owner report: *"the wind isn't always working"* — with this URL: `…/overlay=wind-gfs@100,basins@100,rivers-fao-2026@100,isobars@100/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed/rivers=medium`. **THE WIND WAS NOT BROKEN — IT WAS PAINTED IN A COLOUR YOU CANNOT SEE.** Measured with Playwright at that exact URL: the animation was running, the canvas was advancing every frame, **1,200 particles at full quality** — and of its **16,828 lit pixels, 10,126 (60 %) were in the near-black end of the published speed ramp** (and on a phone profile, **91 %**). **"By speed" is the ramp published in `data/wind/meta.json`, and its first three stops were `#0b1020`, `#132038`, `#1b3a5c`** — so **everything below 3.6 m/s (13 km/h) was drawn in a colour that vanishes against the dark satellite basemap.** The layer's own comment had named the defect all along (*"the published ramp starts near-black… so a calm wind is invisible on a dark satellite AND on a bright one"*) and had answered it with two OTHER colour modes — the reader was using the published one. **THIS IS THE SAME DEFECT THE OCEAN CURRENTS HAD, AND THE SAME FIX: THE RAMP IS NOW BRIGHT AT BOTH ENDS.** The three darkest stops were lifted (`#0b1020 → #1d4ed8`, `#132038 → #3b82f6`, `#1b3a5c → #38bdf8`) and **nothing else moved** — the hue sequence is the same, every stop's m/s is the same, so the key still reads *"blue = calm, cyan/green = fast"*. **The change is at the SOURCE** (`worker/windmap.py::RAMP_STOPS`), and the published `meta.json` was patched to match, so the **flat map, the 3D globe, the legend and the export all read the same lifted ramp** — a new test asserts the worker and the published file cannot drift. **After: 21,070 lit pixels, 100 % of them bright**, and the calm wind reads as a blue field with the jet stream green. **AND THE SECOND HALF OF THE REPORT WAS THE STYLE.** The reader's URL asks for `wind=particles:speed`, and *particles* is the **sparsest** of the four styles — measured on the same view: **particles 1.39 % of the screen lit, arrows 2.03 %, streamlines 8.52 %** (the default). The wind was working; the reader had picked the quietest-looking mode, and a dot per sample over an ocean reads as almost nothing next to a field of streaks. **The style is in the URL, so it travels with the link** — dropping the `wind=` segment returns the default (streamlines), which is what most readers want. |
| 🌊 **The 2026 river network took 64 seconds and was still loading — now under a second, for the whole zoomed-out map** | ✅ fixed (11-06) | Owner ask: *"can you check that the rivers map is loading correctly or we can do something to make it load faster"* — at the same URL, where the rivers are on at **"Medium"** detail. **THE OVERLAY WAS WORKING CORRECTLY — every tile arrived HTTP 200 — AND IT WAS STILL STREAMING AT 64 SECONDS.** Measured: **36 WMS requests** for one screen, at the publisher's **~2.4 s a tile** (which it does not cache — the same tile twice is the same 2.4 s). **THE FIX WAS NOT A NUMBER — IT WAS A COPY OF THE DATA.** The publisher renders a 256 px tile of this network in ~2.4 s and a 512 px tile of the SAME AREA in ~2.4 s too (the cost is the query and the set-up, not the rasterising), so **the first attempt was to ask for 512 px tiles** — and that was **wrong, and it is the bug behind the next row**: `tileSize` does not change the output size, it changes the **GRID the coordinates live on**, so every tile came from the wrong quadrant of the world. **The right fix is to stop asking.** The whole 2026 edition — **8,477,883 reaches** — was paged out of the publisher's WFS into our own copy and rendered into a **static PNG pyramid** (z0-z4 × four detail levels): the publisher is not involved at all below z5, and the world view now arrives in **0.71 s** and a country-sized z4 view in **1.63 s**. Above z4 the publisher still answers, through our caching proxy — **2.9 s** once the proxy's disk cache has the area, and **18 s for the very first reader of it**, and a local file for everybody after that. **The images are still 512 px** — that part was always free — but the **grid** is the standard 256 px one. |
| 🟫 **The soil type vanished from the hover card — it is in it now** | ✅ fixed (11-05) | Owner ask: *"the popup for soil isn't helpful put that with all the other details maybe have the mouse pointer show what the soil type is"* — with the layers dropdown in front of him, where **🟫 Soil** (SoilGrids, ten properties) and **🟫 Soil type (HWSD v2.2)** (the FAO/IIASA WRB classes) sit as two separate rows. **THE READING WAS THERE AND THE CARD COULD NOT SEE IT.** The HWSD layer already exposed `sampleAt()`, but **it was never in the Hover HUD's `SAMPLERS` list** — and the effect was worse than a missing row, because **its own hover box STANDS DOWN in "Everything" mode** (every probe does, so the card never has two things saying the same thing). **Measured on the live map**: with the layer on, hovering read **"Technosols"** in a little box beside the cursor; switching the HUD to **"Everything"** showed the coordinates, the pin and **no soil type at all** — the box had stood down and nothing replaced it. So the answer to "the popup for soil isn't helpful" was not a better popup: it was that **a probe box and a HUD row are two halves of one thing**, and this layer had only the first. **One line in `SAMPLERS`** puts the soil type in the ONE card with all the other details, where the reader expects it — the card now reads `48.8358°N, 2.4170°E · z6` / `🟫 Soil: Technosols`. **IT COSTS NOTHING MEASURABLE**: the class is a colour lookup in the pre-coloured tile under the cursor, and the decoded tile is cached, so it reads one pixel of a bitmap the browser already has — a **51-point pointer sweep with the HUD in "Everything" mode and the layer on measured 59.9 fps**. **AND THE TWO MODES NOW COVER EACH OTHER**: the layer's own small box answers in **"Pins" mode** (where the card deliberately shows pins only), and it **goes away** in **"Everything" mode** — a probe that merely stops updating would keep its last text and go on saying the soil type beside the card that says it too, so `hover-info.js` now announces the mode change (`xyzo:hover-mode`) and the layer hides its box. Pinned by two new tests in `hover-info.bun.test.js`. |
| 🔧 **The soil property switcher was broken for EVERY property** | ✅ fixed (11-05) | Found live while shipping the USDA chip: switching soil property (wrb→clay, wrb→usda — any switch) **silently killed the layer**. `setProperty` removed the tile layer and added a freshly *built* one, but the Leaflet layers control is constructed with **one object per overlay**: the removal fired `overlayremove`, which the module's own listener turned into `state.enabled = false`, while the replacement fired **no** `overlayadd` (the control had never seen it). Measured on the unchanged wrb→clay switch: **no `meta.json`/`grid.bin` fetch at all**, legend stuck on the previous property, **every chip disabled** (`refreshPropButtons` reads `state.enabled`), and `onLayerToggled(false)` wrote `localStorage["xyzo.soilLayer"]="0"` — so the **next visit lost the layer entirely**. Only the tiles and the corner credit looked right, which is why it hid: the visible half worked. The fix swaps the **URL on the same object** (`tileLayer.setUrl(...)`) so no layer event fires at all, and re-credits the corner by hand through `attributionControl.add/removeAttribution` (setUrl fires no events for it to hear). Pinned by a mutation-checked test in `soil-layer.bun.test.js` (re-introducing remove+build fails it). Also verified: `population-layer.setEnabled` adds/removes the *same cached* object, so it never had this bug — soil was the only layer with the rebuild pattern. |
| 🟫 **A second soil model: the 12 USDA soil orders (30 m)** | ✅ shipped (11-05) | Owner ask: *"i think there are several types of soil maps.. lets use as many models as we can."* The Soil layer's switcher gained a tenth chip — **`usda`, the 12 orders of the USDA Soil Taxonomy** (Alfisols … Vertisols) from **OpenLandMap-soildb** at **30 m**, a genuinely different classification from the WRB groups beside it and a **different publisher** (CC BY 4.0 both). It sits right after the WRB chip because both are *classification* maps. **Three traps, each found by running it rather than reading it**: **(1) THE CREDIT MUST FOLLOW THE TILES.** Nine properties credit ISRIC, this one credits OpenGeoHub — a single static "SoilGrids" corner credit would be a **licence breach in the most visible place on the page** while USDA tiles are on screen. `PROP_ATTRIBUTION` + `attributionFor(key)` re-credit on every property switch, and the **export surface uses getters** for `attribution`/`source` (the export contract preserves accessors — a literal would freeze whichever publisher was active at registration time, long before any grid arrived). **(2) THE LAYER'S OWN NAME HAD BECOME FALSE.** It was "🟫 Soil (SoilGrids)" — now nine of ten properties are ISRIC's and one is OpenGeoHub's, so it is **`🟫 Soil`**, with **the slug kept `soil-soilgrids`** (`REVERSE_LAYER_SLUGS`) so every shared link, preset and bookmark keeps working byte-identically: *a slug is an identifier, not a claim*. **(3) THE RASTER ISN'T 12 CLASSES — it is ~818 SUBCLASS CODES.** The publisher's SLD maps every code to its parent order ("79" → "1. Alfisols"), so classification is a **LUT**, not the interval breaks the other properties use — and the LUT is sized for the whole UInt16 range so nodata (32767) indexes to transparent instead of throwing mid-build. The probe grid stores the **published order index (1..12)**, never the raw code, because the client looks values up in `meta.classes` by `index`. **The source is a single 32.6 GB Cloud-Optimised GeoTIFF read by window over HTTP** — never downloaded whole; its SLD lives on a *different host* and uses a *namespaced tag* (`<sld:ColorMapEntry>`), which `parse_sld()` now tolerates (matching only the bare tag parses **zero** entries and fails much later as "no colour map"). **The gate is `verify_usda()`**: Kansas → Mollisols, Ukrainian steppe → Mollisols, Indian Deccan → Vertisols, Siberia → Gelisols, Ganges delta → Ultisols, Amazon → Inceptisols — all six pass against the live source; a flipped axis moves every probe to a different climate zone and all six fail at once. Also fixed en route: **`panel-parity`'s scanner only matched the colon form of `LAYER_NAME`**, so any module declaring `const LAYER_NAME = "…"` (HWSD, mag, wind, ocean-current) was **invisible** to *"added to the flat map but neither ported nor listed in NOT_PORTED"* — HWSD was the first generic-loop module with no literal app.js registration to fall through that hole; the scanner accepts both forms now. Tests: suite **1484 pass / 0 fail**. |
| 🟫 **Soil type (HWSD v2.2): 34 WRB soil groups at ~1 km** | ✅ shipped (11-05) | Owner ask: *"i think there are several types of soil maps.. lets use as many models as we can.. i also really like this soil map can we add as well? Harmonized World Soils Database v.2.2"* — the FAO/IIASA **Harmonized World Soil Database v2.2**: every cell on Earth classified into one of **34 FAO 1990 Revised Legend units** correlated to WRB 2022 (Acrisols … Vertisols, plus open water and glaciers), ~1 km / 30 arc-second, **CC BY 4.0**. It answers *"what kind of soil is HERE"* where SoilGrids answers *"how much sand and clay is HERE"* — the two are now side by side in the dropdown. **Hotlinked as a WMTS, not baked** (a faithful 1 km pyramid is millions of tiles; a GetTile *is* an XYZ template Leaflet reads directly — same trade as WorldPop/GIBS/Macrostrat). **The catalogue URL was wrong in THREE ways, all found by asking the service**: `tilematrixset=EPSG:900913` → 400 (real name `WebMercatorQuad`), no `style` parameter → 400 `Missing 'GetTile' parameters: {'style'}`, and `TileCol={y}&TileRow={x}` **swapped** (transposed tiles would look like a plausible map of the wrong places — no error catches that). The **34 legend colours were decoded from the service's own `GetLegendGraphic`** (221×1154 PNG, one swatch per text row) and paired with the class list in order. The **hover probe reads the tile's own pixel** (CORS `access-control-allow-origin: https://xyzo.org` verified) through a per-URL decoded-canvas cache, and reports **"unknown colour" rather than guessing** when nothing matches — a wrong soil unit is worse than no reading. **Three defects found by running it, not reading it**: (1) `mountLegend()` returned `true` when `.leaflet-control-layers-list` did not exist yet, which told the retry loop the key was mounted and stopped it — the legend never appeared (app.js's layer-init loop runs BEFORE `L.control.layers()`); (2) `init()` set `state.enabled` from localStorage but registered **no `overlayadd`/`overlayremove` listeners**, so a shared link that added the layer left the legend hidden and the probe dead over a map that WAS showing the tiles — the population-layer rule (listeners before the restore) now applies; (3) **the key was mounted AFTER the `<section>` instead of inside it**, so it escaped the panel entirely and hung beside the stack button while the dropdown was closed — fixed 2026-11-06, measured before/after in the System Health row of that date and documented in its own section below. **Pane `hwsdPane` 370** — the slot the wind animation vacated when it moved to **379**, because the stack was full 345–370 and a ground layer at 371+ would have drawn OVER the wind streaks. Free slots now **372–378** (371 went to the FAO rivers). Wired through `generic-layers.js`'s registry (like population), so it is deliberately **not** in `overlay-contracts`' `OVERLAYS` table — that table demands literal `app.js` wiring a registry layer can never satisfy; its contracts live in the new **`hwsd-layer.bun.test.js` (27 tests)**. Tests: suite **1482 pass / 0 fail**.
| 📊 **The map-settings telemetry 500'd on about one page load in five** | ✅ fixed (11-07) | Found while measuring load speed: `/api/analytics/map-settings` returned **500** intermittently. **THE CAUSE WAS A RACE ON ITS OWN NATURAL KEY.** The write is `DELETE` the session's rows for the day, then `INSERT` — and the client fires it whenever the view settles, so two writes from the same session could overlap: both `DELETE`s find nothing, both `INSERT`s run, and the second dies on `map_settings_usage_natural_key` (the migration even says *"the write stays idempotent"* — but DELETE-then-INSERT is not idempotent under concurrency). **THE FIX IS AN UPSERT ON THE CONSTRAINT'S OWN KEY** (`ON CONFLICT (day, session_id, kind, key) DO UPDATE`); the `DELETE` stays, because a session that turns a layer OFF must lose its row. **Verified: six concurrent writes from one session → all 200, zero `write failed` lines in the API log** (there had been one per few loads). || ⚡ **The map downloaded 38 MB of data for overlays that were all OFF** | ✅ fixed (11-07) | Owner ask: *"can we write some speed tests for everything all the maps and kinda slowly work on improving the load speed and all that?"* **MEASURED FIRST: the bare map — ZERO overlays switched on — downloaded 41.5 MB across 188 requests, and 38 MB of it was grid data for layers that were all OFF** (Playwright, fresh context, reading the browser's own Resource Timing API). **The lightning grid alone was 17.8 MB, and every visitor paid it whether or not they had ever switched the lightning on.** **THE CAUSE WAS TWELVE LAYERS WITH AN IDLE `requestIdleCallback` "warm"** whose purpose was *"switching the layer on is instant"* — it ran for every visitor at idle, so it was a cost paid by the readers who were never going to use it. **THE TEMPERATURE LAYER ALREADY HAD THE RIGHT RULE** (warm only `if (state.enabled)`), with a comment saying exactly why; the other nine now follow it, and `city-labels.js`'s warm was deleted outright — it ran only when the layer was *not* restored on, i.e. it loaded the 1.2 MB city index for exactly the readers who would never see a label. **THE SECOND HALF: THE LEGEND NEEDS THE META, THE MAP NEEDS THE GRID.** Several layers' **legend mount** also called `ensureData()` — and the legend lives in the dropdown whether or not the overlay is on, so mounting it at boot pulled the whole grid. Split into `ensureMeta()` (a few KB, at boot) / `ensureGrid()` (megabytes, on demand) / `ensureData()` (both, on add). **THE THIRD HALF, FOUND BY THE TEST: A LAYER WITH NO `BASE` HAS NOTHING TO FETCH.** The field-layer factory also serves the wind-speed field, which reads WindLayer's own grid — so the new `ensureMeta()` asked for **`/undefined/meta.json`: a 404 on every page load** (35 runs, 35 of them). Guarded on `BASE`. **MEASURED AFTER: 170 requests, 4.8 MB — an 8.6× reduction, and ZERO overlay grid files on a page where nothing is switched on** (the last one out was the **wind grid, 4 MB**: the wind-SPEED field's legend was getting its meta through `loadData()`, which drags the whole grid — so the field-layer gained a `loadMeta` hook and `WindLayer.ensureMeta()`, and the legend now costs 1 KB). **Switched on, a layer fetches its own data and nothing else: wind on → the grid arrives and 207,637 pixels draw; wind-speed on → the same grid, one fetch shared by both layers.** **TWO NEW TESTS, BOTH DRIFT-FREE BY CONSTRUCTION.** `scripts/overlay_load_check.py` screenshots all **35** overlays against a map that never had them on — no layer names, no pane names, no URL patterns — and **35/35 still paint when switched on** (2 console errors, down from ~41). That gate is the point: the load now happens on a path a cold start never used to exercise, so a layer that stops fetching would switch on, tick its box and draw nothing. `scripts/map_speed_audit.py` measures every layer's requests, bytes, quiet-time and errors from the browser's own numbers. || 🌊 **The rivers were on the wrong CONTINENT — `tileSize: 512` moved the grid** | ✅ fixed (11-06) | Owner report: *"are you sure the rivers are working correctly they look to be not placed correctly when i view it… did you test with playwright?"* — and they were RIGHT. **THE TILES WERE FETCHED FROM THE WRONG QUADRANT OF THE WORLD.** Leaflet's `_pxBoundsToTileRange()` divides the pixel bounds by the **TILE SIZE**, so a layer with `tileSize: 512` asks for a **512-px GRID** — its tile (11, 7) covers the ground of the STANDARD square (22, 14). Our pyramid and the publisher are both cut on the standard 256-px grid, so every tile came from the **north-west quadrant of where it belonged**: **a tile the map wanted at longitude 85° was fetched from longitude -56°**, and the rivers were drawn over the Indian Ocean out of Greenland. **IT SURVIVED EVERY SCREENSHOT** — the picture still looked like a plausible river network, just from the wrong continent — and it survived the pixel-for-pixel comparison with the publisher, because both sides were being asked the same wrong question. **THE WAY IT WAS FOUND:** the map's own tile square (`x` 20-26, `y` 11-13) was compared with the tile the layer actually requested (`x` 6-8) — a difference of exactly 2× in both axes, which is `512/256`. **THE FIX IS ONE OPTION: `tileSize` STAYS AT THE DEFAULT 256.** The sharpness comes from the IMAGE instead — the publisher renders the standard square at 512×512 and the browser downscales it into the 256-px slot, which is free (the publisher's cost is the query, not the rasterising). **It is the same rule the Macrostrat geology layer already records.** **THE OTHER HALF WAS THE CACHE:** a `*.png` under `public_html` is served **`immutable` for a year** and the proxy answers with `max-age=604800`, so the misaligned tiles stayed in every reader's browser for a week — **every tile URL now carries a `?v=` build token**, because a URL is the cache key. **AND THE SERVICE WORKER WAS PRINTING AN ERROR ON EVERY VISIT** (`sw.js:232`): it wrapped the Live Feed's `EventSource` in `respondWith`, so every abort printed *"A ServiceWorker intercepted the request and encountered an unexpected error"*. The stream itself was fine; **a service worker must not intercept a stream at all**. **VERIFIED AT THE READER'S OWN URL: 35/35 tiles 200, the tile square now matches the map's, the rivers follow every coastline (the Amazon, the Congo, the Ganges, the Mississippi, the Yangtze, the Volga) and the ocean is clean.** Pinned by `fao-rivers-layer.bun.test.js` and `offline-layer.bun.test.js`. |
| 🌊 **The 2026 FAO river network is on the map — with a detail selector and a river-names switch** | ✅ shipped (11-05) | Owner ask: *"can you try and add the more detailed version of 'rivers' so we can select options.. also the other version has labels we want with or without river labels... and as detailed as possible if they want"* — pointing at the FAO AQUASTAT **"Rivers (Global, edition 2026)"**. **SHIPPED as a second layers-dropdown entry, "🌊 Rivers (FAO 2026)", carrying the two options the ask names: a DETAIL selector and a RIVER-NAMES switch.** It is a **different dataset** from the Natural Earth rivers, not a version of them: the 2026 edition is the HydroRIVERS line layer — **every river reach on Earth with a catchment of 10 km² or an average flow of 0.1 m³/s**, more than a million reaches. **THE LINES ARE RENDERED BY US BELOW z5 AND BY THE PUBLISHER ABOVE IT** — the network is far too large to ship as data (a 10° box of it is **28 MB** of GeoJSON), so it has to be *rendered* rather than sent; since 2026-11-06 we render the zoomed-out half ourselves, from our own copy of the network (see the row below), and the publisher renders the rest at whatever zoom it is asked for — which is what makes *"as detailed as possible"* possible at all. **THE DETAIL LEVEL IS A SERVER-SIDE FILTER**, so the thinning happens on the publisher's side and the tiles stay small: **Major** (`dis_av_cms >= 100`) · **Medium** (≥ 10) · **Fine** (≥ 1) · **Full detail** (no filter — every reach, down to 0.1 m³/s). The four are measurably four different pictures: **38 KB / 73 KB / 144 KB / 226 KB** for one 256 px tile over the lower Amazon. **TWO THINGS HAD TO BE FOUND BY MEASURING, AND BOTH ARE TRAPS.** **(1) THE PUBLISHER'S OWN STYLE OMITS 59 % OF THE NETWORK.** Its published style (`river_network_v1`, "River Network - Order and Perenniality") has rules for `ord_flow` **1..6 only**, so **every reach of order 7 and finer is not drawn by it at all** — and those are **42,610 of the 71,687 reaches** over the lower Amazon. A GetMap for exactly those reaches (`CQL_FILTER=dis_av_cms<1`) comes back as a tile with **ZERO opaque pixels**: HTTP 200, no error, an empty map. "Full detail" would otherwise have meant *"the publisher's finest drawn class"* and not the network. **(2) THE PUBLISHER'S CARTOGRAPHY IS DARK-ON-LIGHT AND VANISHES ON OUR DARK BASEMAP** — order 1 is `#042946`, near-black navy, and the pale classes carry the fine network, so over the default satellite basemap the main stems disappear and only the tributaries survive: the layer draws and the reader sees almost nothing. So the client sends **its own SLD** (GeoServer's `sld_body` vendor parameter), built from the same attributes the published style uses (`ord_flow`, `smooth_200`) but **bright at both ends** — the greatest rivers read white, the finest twigs a pale thread, the intermittent reaches a dashed amber. **The SLD is BUILT BY THE BUILDER AND PUBLISHED** (`scripts/river_network_build.py` → `meta.json`), so the **legend's key and the map are drawn from the same rows** and cannot disagree. **TWO MORE MEASURED TRAPS LIVE IN THE SLD.** **`ogc:PropertyIsBetween` CRASHES GeoServer's renderer** — a dynamic SLD using it answers HTTP 200 with a ServiceException carrying `java.lang.NullPointerException`, i.e. a blank tile and a silent failure, so a range is expressed as an `ogc:And` of two comparisons instead. And **every matching rule RENDERS**: a cumulative ladder (`ord_flow <= 2`, then `<= 4`, …) painted the whole Amazon in the palest colour of the ramp, so the ranges have to be **disjoint**. **THE NAMES COME FROM THE CLASSIC LAYER, because the 2026 network carries no names on its reaches** (`HYRIV_ID`, `NEXT_DOWN`, `ORD_FLOW`, `LENGTH_KM`, `DIST_UP_KM`, `DIST_DN_KM`, `UPLAND_SKM`, `CATCH_SKM`, `DIS_AV_CMS` — and no `NAME`). They come from the FAO's own classic rivers layer (`rivers_world_47950`, 86,882 named features) and are published as **5,097 anchor points**. **A NAME IS ONLY LABELLED IF IT IS A RIVER**: `maj_name`/`sub_name` are BASIN names and many are places — "Gobi Interior", "Hudson Bay Coast", "Lake Chad", "Sahara" — so a word list drops every name that reads as land or sea (**62,912 dropped**); trailing digits go too ("Amur1"…"Amur4" are one river's numbered sub-basins, not four rivers). **THE LEVEL TRAVELS WITH THE LINK** (`/rivers=full`), the same argument as the isobar step: "Major" and "Full detail" are different maps, and a link that opened at the reader's own level would be the same river in a different network. Verified live on the running site: the dropdown entry, the four chips, the legend, **the tiles actually arriving from the publisher (HTTP 200), 15 river names placed on the Amazon, the names switch emptying them, and the level in the URL** — `scripts/fao_rivers_audit.py`, all checks green. |
| ⛅ **The pressure lines now go down to 0.25 hPa** | ✅ shipped (11-05) | Owner ask: *"would it be possible to add pressure lines (isobars) detail down to .5 hPa that would be so awesome!"* — and then, a day later, *"i think we even need .25 hPa"*. **YES, AND IT IS STILL NOT NOISIER** — that is the whole point of the measurement, and it now holds across three halvings: the share of lines shorter than 20° is **54.8 % at 1 hPa, 55.0 % at 0.5 and 54.8 % at 0.25** (under 5°: 20.0 %, 19.5 %, 19.5 %). The line count doubles each time — **1,117 → 2,240 → 4,459** — and the chart is the same chart with more lines in it. The chip row is **0.25 / 0.5 / 1 / 2 / 4 / 8 / 16** and the API's `step` accepts `0.25` (and still rejects `0.7` with a 400). Published: **GFS 4,459 lines across 351 levels (957.75…1045.25)**, **ECMWF 3,908 across 329**. Verified in the browser: **662 lines / 160 levels** at 0.25 against **178 / 40** at 1 and **48 / 10** at 4 in the same viewport — a proper superset. **THE FRACTIONAL STEP ALSO NEEDED TWO-DECIMAL ROUNDING IN THE API**: `stepLevels()` accumulated the level list by repeated addition and rounded to a tenth, so `0.25` would have produced **1000.2499999999999**, which never matches the stored `REAL` — it now accumulates in whole multiples of the step and rounds to two decimals. **TWO THINGS HAD TO CHANGE THAT ARE NOT OBVIOUS.** **(1) The schema**: `level_hpa` was `INTEGER`, so 1000.5 could not be stored — migration `2026-11-05-weather-isobars-half-hpa.sql` makes it `REAL` (1000.5 is exactly representable in float4, and the 2,109 existing integer rows convert unchanged). **(2) The no-op guard**: it compared the *cycle* and the *product* — and changing the interval changed neither, so it declared *"already published"* and **the finer set never shipped**. `weather_isobars_build` (migration `2026-11-05-weather-isobars-build.sql`) records the interval, and `store_isobars()` writes it, so any future build parameter has a home. **The `iso=` hash parser had to learn fractional steps too** — `/^iso=(\d+)/` would have read `iso=0.5` as step **0** and dropped the segment entirely; it is now `/^iso=(\d+(?:\.\d+)?)/` in `app.js`, `map-presets.js` and `globe.js`. The contour loop went from `range()` to a `while` with an epsilon (`range()` refuses a float step), with **no `continue` on an empty level** — the increment is at the bottom of the body, so skipping an empty level would have skipped the increment and spun forever. **THE GATE'S TOLERANCE WAS RECALIBRATED FROM THE MEASUREMENT.** The offset this check measures is the chart's own SIMPLIFICATION (Chaikin ~0.06°, Douglas-Peucker 0.03°) times the local pressure GRADIENT — a fixed distance, so it is a property of the field, not of the data's correctness. What changes with the interval is the LEVEL SPACING: the lines are half as far apart, so the same displacement is a bigger fraction of the gap between them, and in a steep gradient a vertex can land a whole half-hPa from its own level. Measured across all three intervals on the same box: **p95 0.029 → 0.51 → 0.75 hPa** and **median 0.001 → 0.499 → 0.497** — so the artefact is driven mainly by the GRADIENT of that particular analysis and only mildly by the interval. The tolerances are now **p95 1.0 / mean 0.5 / median 0.6**, set between the artefact (0.51) and the smallest real error (a level 1 hPa out = 1.003, a wrong cycle = 6.2–14.5, a mirrored field = 12.0) rather than guessed. **AND THE MUTATIONS HAD TO MOVE**: a ONE-cell shift now sits inside the artefact band, so the tests shift by TWO cells — *a gate that cannot fail is worse than no gate*, the same reasoning as the mirror control in the wind audit. Tests: `isobar-step.bun.test.js` (29), `isobar-layer.bun.test.js`, `api/tests/weather-isobars.test.ts` (10), `worker/tests/test_isobars.py` (48), `worker/tests/test_gfs_verify.py` + `test_gfs_verify_isobars.py` (88). **SUPERSEDED ON 2026-11-06 — see the row above.** Three claims in this row are no longer true: the ladder is **EIGHT chips** (0.10 was added and the lattice had to move to 0.05), the tolerance story below was **wrong** — the `p95 0.029 → 0.51 → 0.75` growth was the checker's own `int(level_hpa)` truncation, not the pressure gradient — so the tolerances are **back at 0.4 / 0.25 / 0.6** and the mutation test shifts **one** cell again, and the test counts are 30 / 27 / 11 / 48 / 40. The rest of this row (the `REAL` schema, the interval in the build record, the two-decimal `stepLevels()`) stands. |
| 🌬️ **The wind was published at 1° — and it was 78° wrong at Nairobi** | ✅ fixed (11-04) | Owner report: *"our maps dont' look correct they show different pressure lines and wind direction then windy.com"*. **THE WIND GRID WAS TOO COARSE TO CARRY THE ANSWER.** It was published at **1°** because the grid is held in the browser and 0.25° was thought too heavy for *"a vector field whose direction barely changes across a cell"*. **That last part is false, and it was measured.** The **same GFS cycle** at 1° and at 0.25°, at twenty-four points: the direction agrees **exactly at nineteen of them**, and then **Nairobi is 78° out** and **Sydney 41° out** — the two places where the flow has structure finer than a degree (the Albertine convergence zone, the Australian sea breeze). A reader pointing at Nairobi was told the wind blew **from the north** when the analysis said **north-east**. **The wind is now published at 0.25° (721 × 1440)**, matching the isobars, which had always been 0.25°. Verified live: the probe at Nairobi now reads **"from NE (47°)"** where it read **"from NNW (335°)"**, and against Open-Meteo's GFS — a completely different code path reading the same NOAA analysis — the same point agrees to **3.8°** (it was 78°). The cell-by-cell audit now compares **1,038,240 cells** against the raw GRIB, max diff **0.0034 m/s**, 0 over tolerance. **THE COST IS PAID BY THE RIGHT PEOPLE:** 3.96 MB raw / **~2.8 MB gzipped**, against 255 KB / 196 KB, and it is fetched only by the readers who switch the wind layer ON. **The globe keeps a 1° copy** (`grid-1deg.bin` + `meta-1deg.json`) — written by the **same run from the same fetch**, so the two cannot disagree — because the globe draws 900 streaks on a sphere and shows no numbers at all. **THE TEMPERATURE MOVED TO 0.25° TOO** (median error 0.0 °C, worst **2.4 °C** at Sydney), so all three GFS overlays are the same resolution as each other. **FOUR PLACES IN THE AUDIT ASSUMED A 1° LATTICE** and had to be generalised — the isobar check's `row = lat + 90` put the pressure field in the wrong cells (max diff 34.7 m/s, a shape that looks like a scrambled field and is nothing of the sort), the mirrored-wind control was hardcoded to 90 rows and crashed, the trade-wind test read the mid-latitude westerlies when it meant the trades, and the antimeridian seam moved from 359.5° to 359.875°. |
| 🕐 **The GFS workers polled every 6 hours — so the map could sit on a stale cycle, or miss one entirely** | ✅ fixed (11-04) | Owner ask: *"can we get new data say every 10 min so we have really accurate temp/pressure weather maps"*. **THERE IS NO GLOBAL ANALYSIS AT 10-MINUTE CADENCE** — the GFS and ECMWF IFS analyses are **6-hourly** and HRRR is hourly and North America only; ten-minute cadence belongs to *nowcasts*, not to a global analysis. **WHAT IS ACHIEVABLE IS TO STOP SITTING ON A STALE CYCLE, AND THAT IS WHAT CHANGED.** The three workers now poll **every 15 minutes** instead of every six hours, so a new cycle is picked up within minutes of NOMADS publishing it. **AND THE POLL IS ALMOST FREE**, because each worker compares the **cycle AND the product** before fetching: the isobar worker went from **5 minutes to 1 second** on a no-op tick, and the ECMWF fetch — four minutes of work for a twice-daily product — is skipped entirely. **THE PRODUCT COMPARISON MATTERS**: comparing the cycle alone would have declared *"already published"* when the **resolution** changed, and the new 0.25° grids would never have shipped. The isobar worker's early no-op is new (it had none, so it re-contoured the whole world every tick); the wind and temperature workers already had one, extended to the product. **THE TIMER FILES ARE IN `deploy/`, AND SINCE 2026-11-06 THE LIVE UNITS MATCH THEM**: the owner edited `/etc/systemd/system/xyzo-{isobars,tempmap,windmap}.timer` and reloaded, so all three read **`OnUnitActiveSec=15min`** and differ from `deploy/` in **0 lines** — and the first tick afterwards did the cheap ECMWF **HEAD** probes and downloaded nothing. **`daemon-reload` alone does NOT fix this**: it only re-reads the files, so the unit has to be *edited* first — that missing step is why the first attempt changed nothing. The remaining gap is the missing cross-process lock, now the whole of **Q-N17**. |
| 📐 **Our lines are 215 km from windy.com's — and the WEATHER is the same** | 🔎 measured (11-04) | *"im not really following why our maps look so different from windy.. shouldnt tehy be very similar or betteR?"* **THEY SHOULD, AND NOW THEY DO — but only when the model matches.** windy.com draws **ECMWF 9 km** (read off its own model selector: "ECMWF 9km | GFS 22km | ICON 13km"); we drew GFS. **AT A POINT the two models agree closely** — median **7°** of wind direction, **0.6 °C** of temperature, **0.6 hPa** of pressure over twelve points. **BUT THE LINES ARE FAR APART**: the *same* pressure level drawn by both models is a median of **185–234 km** apart (1012 hPa: median **223 km**, p95 **2,249 km**, max **3,345 km**). **WHY:** in a weak gradient, a 0.6 hPa difference moves an isobar a couple of hundred kilometres, and over a deep low the models disagree about the low's *shape* and the lines separate by thousands of kilometres. **The weather is the same; the line is somewhere else.** At zoom 3, 215 km is twenty pixels. **So the map was never wrong and never "worse" — it was a different model at a coarser resolution.** The **analysis picker** (Auto · ECMWF · GFS · HRRR) makes the model the reader's choice, and it travels with the link. **TO COMPARE LIKE WITH LIKE: pick ECMWF, use 4 hPa (not 1 hPa — 1 hPa is 1,117 lines), and compare the NUMBERS rather than the lines.** Full measurements: **`docs/CLIMATE_ACCURACY_2026-11-04.md`**. |
| 🖱️ **The layers dropdown is now ordered by what people actually use** | ✅ shipped (11-05) | Owner ask: *"start keeping track of what all users use as there settings and also the specific user using the settings… and then specify [the Cool maps chips] based on the typical user settings… also can you order [the overlay rows] based on user activity"*. **ONE ROW PER SESSION PER DAY PER SETTING** in `map_settings_usage` — which overlays were on and at what opacity, which preset was opened, which base layer, plus the settings that are not layers at all (pin density, isobar step/colour/analysis, wind style). The write **replaces the session's rows for the day**, so twenty toggles cost one row each and a session that changes its mind does not inflate the aggregate; the natural key `(day, session_id, kind, key)` makes it idempotent. **The dropdown is ordered by it**: the report arrives after the control exists, so the ROWS are re-ordered in the DOM rather than the control being built in a different order (which would need the fetch to block boot), and a **MutationObserver re-applies the order** because Leaflet rebuilds the list on every layer change. Measured live: with Temperature and Wind on 6 sessions each, Soil on 1 and the rest on 0, the list came out **Temperature · Wind · Soil · …** in that order, and the ⛅ isobar row is correctly left alone — it lives outside `.leaflet-control-layers-overlays` (injected as a sibling, per the layers-dropdown rule). **Two things had to be right**: the report keys on the **slug** (it survives a rename) while the DOM shows the **name**, so the client resolves one against the other; and an unknown row keeps its relative order and goes last, so a layer with no data yet is not worse than one with none either. **`GET /api/analytics/map-settings?preset=storm` answers the second half of the ask**: the overlays those sessions had on, with **`pct_of_openers`** — a curated "Storm watch" that everybody immediately turns the lightning off in is a preset with a wrong layer in it. That number does not exist yet (the table went in today) — the presets get tuned against it once a season of use has accrued, which is the honest order to do it in. Telemetry, so it is pruned with the rest (`retention_prune.py`, 90 days) and it stores **no IP and no user agent** — the session id is the random localStorage key analytics.js has always used. Tests: `map-settings.bun.test.js` (21 new). |
| 🖱️ **The overlay palette kept closing before you could pick a colour — the row sorter was looping** | ✅ fixed (11-05) | Owner report: *"when i click on [the palette options] it hides too quickly and wont let me select it"*. **`appendChild` ON A NODE THAT IS ALREADY IN PLACE IS STILL A childList MUTATION** — it removes and re-inserts. The overlay-row sorter I added for the usage ordering re-appended an unchanged list, which re-fired its own `MutationObserver`, which scheduled another sort, which re-appended… **Measured: 47 mutations in 2 seconds over a 32-row list** — the rows were being relocated ~23× a second while nothing had changed. **TWO CONSEQUENCES, BOTH OF WHICH THE OWNER HIT.** **(1) MOVING A `<select>` CLOSES ITS OPEN POPUP** — that is exactly why the palette dropdown "hid too quickly and wouldn't let me select it": the row under the cursor was moving faster than a click could land. **(2) It burned the frame budget**, and `autoQuality()` sheds particles when the frame rate drops (AGENTS.md: *FPS < 40 sheds, floor 0.4*) — so the wind animation was thinning out for no reason the owner could see. **THE FIX IS ONE LINE AND IT IS A GUARD, NOT AN OPTIMISATION**: compare the desired order against the DOM first and return without touching anything when they already match — `if (keyed.every((k, i) => rows[i] === k.el)) return;`. Measured after: **47 → 0 mutations in 2 s**, the palette select stays connected with **0 moves** through an interaction, and its `change` event still fires (`published` → `turbo` verified). The comparison is also the correct semantics: a settled list should cost one comparison and no DOM writes. Tests: `hard-refresh.bun.test.js` (**10**). |
| 🔄 **A hard refresh the reader can actually press — because `*.js` is `immutable` for a year** | ✅ shipped (11-05) | Owner ask: *"we might need to suggest to users to press ctrl shift r to do a hard refresh sometimes???"*. **THEY ARE RIGHT, AND HERE IS WHY IT CANNOT BE A NORMAL RELOAD.** The Caddyfile serves `*.js` and `*.css` **`public, max-age=31536000, immutable`** — so the browser holds `app.js?v=X` and never asks for it again for a year. `index.html` is `no-cache`, so the HTML is always fresh — but if a deploy edited a file **without bumping its token**, the fresh HTML still points at the same stale URL, and only a hard reload (Ctrl+Shift+R) fixes it. That is the documented 2026-10-31 incident, and it is the one case a page cannot otherwise detect. **A PAGE CAN DO IT ITSELF**: `fetch(url, { cache: "reload" })` bypasses the HTTP cache **and replaces the stored entry**, so pulling every script and stylesheet from the network first leaves FRESH BYTES behind the immutable URL — then dropping the service worker's shell (it caches the app too) and reloading gets the new code. New **⚙ → TOOLS → Hard refresh** button does exactly that; its title names the shortcut (*"…or press Ctrl+Shift+R (Cmd+Shift+R on a Mac)"*) because that is what people are told to press and support should be able to repeat it. **AND A SUGGESTION WHEN THERE IS SOMETHING TO SUGGEST**: `checkForNewVersion()` fetches the served `index.html` (always fresh) and compares its `app.js?v=` with the token this tab booted from — if they differ, a deploy landed while the tab was open and a **"· new version"** badge lights on the button. It is deliberately INSIDE the menu rather than a floating banner: the map chrome (the Help Me pill, the bottom bar, the search pill) all have their own measured collision bands, and a suggestion that covers the gear is worse than one you find when you open it. Verified live: the button primes `/app.js` and `/styles.css` from the network (6 requests) and **the page reloads** (`window.__marker` gone), the badge stays hidden when nothing has changed. Tests: `hard-refresh.bun.test.js` (**10**). |
| 🌬️ **The wind streaks were buried under the isobars — the stroke now follows the density** | ✅ fixed (11-05) | Owner report: *"is the wind particle animation working.. i can't seem to see it?"* at a URL with **`iso=0.25`** and eight overlays on. **IT WAS WORKING** — measured on that exact URL: 1,200 particles, the canvas drawing and advancing (18,135 → 18,328 lit pixels over 1.5 s), `style: particles`, `colorMode: speed`, opacity 1, **0 console errors**. **WHAT WAS HIDING IT: the isobars.** With 0.25 hPa at zoom 3 the chart is ~1,000 thin lines that follow the flow — **exactly what the wind streaks look like** — and at a fixed 1.4 px stroke the coverage is more than the viewport can hold, so the map goes solid. **A/B screenshots of the same URL**: isobars OFF → the wind streaks are immediately obvious; isobars ON → buried. **THE FIX**: the stroke now follows the **density**, not the step — `weightFor(count)` returns 1.4 for a classic chart (≤120 lines), then 1.0, 0.7, then 0.5 for a world view of the finest set, and `repaintLines()` re-applies it (a colour change would otherwise leave the strokes at the previous density). **The reader's choice of step is untouched** — the chart is still 0.25 hPa, it is just drawn at a weight a screen can hold. Measured after: **1.4 → 0.7 px** at that URL, and the wind's strong-pixel count rose from 10,654 to 14,287. **A SECOND, SEPARATE CAUSE**: with eight overlays on, `autoQuality()` sheds particles to protect the frame rate (AGENTS.md: *FPS < 40 sheds, floor 0.4*) — headless measured `qscale 0.4, fps 10`, so the animation was running at **40 % of its particle count**. On a GPU machine it grows back, but a busy map keeps it low. **AND A VISUAL CONFUSION WORTH KNOWING**: at 0.25 hPa the isobars and the wind streaks are the SAME SHAPE — thin curved lines following the flow — so on a still image they are hard to tell apart. The wind moves and the isobars do not; if a reader says "I can't see the wind", ask them to turn the isobars off first, because that is the answer about nine times in ten. Tests: `isobar-step.bun.test.js` (**29**, 3 new). |
| ⏱️ **Switching the isobar detail took 1.1 s — now 0.5 s, and repeats are a 304** | ✅ fixed (11-05) | Owner report: *"isobar switch doesn't seem to be updating fast?"*. **MEASURED**, world zoom, 16 → 0.25 hPa: the chip updated in **16 ms** but the LINES took **1,151 ms**. **THREE CAUSES, ALL FIXED.** **(1) The response had no validator.** The 0.25 hPa world response is **2.3 MB raw / 895 KB on the wire**, and with no `Cache-Control` and no `ETag` the browser had nothing to revalidate against — it re-downloaded and re-parsed the whole body on EVERY switch (the repeat switch measured 932 ms). The route now sends `ETag` + `Cache-Control: no-cache` and answers **304 with 0 bytes** when the browser already holds those exact lines; the identity is the query plus the analysis it was cut from (the worker's no-op guard refuses to re-publish an unchanged cycle, so the geometry cannot move under a fixed identity). **The `If-None-Match` comparison strips the weak `W/` prefix from both sides** — the value that reaches the browser arrives as `W/"…"` (Caddy's proxy adds it), so a strict compare against our own `"…"` never matched and every conditional request fell through to a full 200, which is the 895 KB download the whole thing exists to avoid. **(2) 3,829 SVG paths.** The isobars now render through **`L.canvas({ pane: "isobarPane" })`** — one canvas (2800×1800) instead of 3,829 DOM `<path>` elements, measured 0 paths in the pane afterwards. The pane is set explicitly because a canvas renderer's container otherwise lands in the default overlay pane with `pointer-events` on, and a full-map element there swallows every click. **(3) `L.polyline` creation is only 9-11 ms either way** (measured A/B), so the win is in the browser's paint, not in JavaScript — which is why the canvas matters even though the benchmark barely moves. **MEASURED AFTER: 1,151 → 521 ms (first), 932 → 397 ms (repeat), 280 → 98 ms (0.25 → 4)** — roughly 2× across the board, and at city zoom 120-291 ms where it was already fine. The remaining ~400 ms at world zoom is the server query (~200 ms) plus painting 3,829 lines, and the chip's own state change is 6-16 ms throughout, so the reader always sees their click register immediately. |
| 🖱️ **Three probe boxes stacked on the same 14 pixels — and two of them said different numbers** | ✅ fixed (11-04) | Owner ask: *"the tooltip or 'probe' is kinda overlapping various data and now showing all the info correct"*. **MEASURED on the live map with Playwright, pointer at (800,500):** `.wind-probe [814,514,196,44]`, `#wind-speed-probe [814,514,139,26]` and `.climate-probe [914,574,205,30]` — **three boxes, two of them exactly on top of each other**. Every layer that has a number under the cursor drew its OWN box and placed it at `containerPoint + 14px` — the SAME 14px — so with the wind, the wind speed and the climate all on, the reader saw the top box and the other two were hidden underneath it. **THE SAME FAULT IN THE HOVER CARD**: it placed ITSELF at "cursor + 14px" too, so hovering a story pin showed the card ON TOP of the wind and climate readings. **AND THE TWO WIND NUMBERS DISAGREED** — "2.3 m/s · 8 km/h" and "2.4 m/s · 9 km/h" — because the wind-SPEED field computed its magnitude on a **pre-derived grid**, and `bilinear(u,v) → hypot` is **not** `bilinear(hypot(u,v))`. **THE FIX IS ONE POSITIONER**, `public_html/probe-stack.js`: every readout on the map is laid out in ONE column starting at the cursor, a box that would run off the right edge flips to the left, a column that would run off the bottom flips above, and **the hover card is the TOP of the column** so it never covers a reading. The two coordinate systems are handled explicitly (the layer probes are absolute inside the map container, the card is fixed on `<body>`). **THE LAYERS KEEP THEIR OWN BOXES** — a climate probe carries a swatch, a wind probe a compass point, the temperature probe a °C/°F pair — because the ARMED (tap-to-read) probes are a deliberate single-layer action with their own life cycle. **AND THE TWO WIND READINGS ARE NOW ONE**: the speed field samples the animation's own vector (`WindLayer.sampleVector`) so the number is identical to the digit, and it **stands down** when the animation is on (the animation's probe already carries the speed AND the direction). Verified in the browser: the animation says `5 mph · 8 km/h · 4 kt from SE (145°)` and the speed field, with the animation off, says `5 mph · 8 km/h · 4 kt` — the same number. **THE SPEED FIELD WAS ALSO MISSING FROM THE HOVER CARD ENTIRELY** (it was never in `SAMPLERS`), so with the animation off and the speed field on, "Everything" mode said nothing about the wind at all. Tool: **`scripts/probe_audit.py`** (a real browser, a pointer sweep over 51 positions: **no two readouts overlap, nothing runs off the screen, and every wind reading matches the published grid** — the grid is sampled independently in Python). Study: **`docs/PROBE_STUDY_2026-11-04.md`**. Tests: `probe-stack.bun.test.js` (10 new). |
| 💨 **The wind was in m/s — the owner asked for miles/hour, knots and km/h** | ✅ shipped (11-04) | Owner ask: *"remove m/s and add miles/hr and kt and km/hr"*. **m/s is GONE from every reader-facing wind reading** — the probe, the hover card and the legend's scale labels now read **`14 mph · 22 km/h · 12 kt`** (all integers, which is what every weather service and windy.com print, and a calm wind still reads `0 mph · 1 km/h · 1 kt`, so the light air is never lost). **m/s STAYS THE DATA UNIT**: the published grid, the colour ramp and the export band names (`wind_u_m/s`, `wind_v_m/s`) are all in m/s, because they must stay in the unit the source speaks — only the DISPLAY converts. **NOT CHANGED: the ocean-current layer still reads m/s** — a current is a different quantity from a wind and m/s is its SI convention; the owner's ask was about the wind (recorded here so it is a decision and not an oversight). Pinned by a test that asserts **m/s is gone** from the readout. |
| ⛅ **The pressure lines differ from windy.com — because the reader could not choose the analysis** | ✅ shipped (11-04) | Owner report: *"our maps dont' look correct they show different pressure lines and wind direction than windy.com"*. **THE DATA WAS RIGHT.** The isobars are contours of a 0.5°-blurred GFS 0.25° MSLP field, and the pressure read at a point **on** a served line matches that line's own level to **+0.005 hPa mean / 0.029 hPa p95 / 0.271 hPa max** — three hundredths of a hPa. The wind matches the raw GRIB message **cell for cell (65,160 cells, max diff 0.0042 m/s, 0 over tolerance)**, sits a median **24.1°** off the geostrophic wind with **85.4 %** of the flow angled towards the low, and agrees with Open-Meteo's GFS (a completely different code path) to within a few degrees. **THE DIFFERENCE WAS FOUR THINGS, NONE OF THEM A BUG** — but one of them was a **missing feature**: windy.com draws **ECMWF** by default and the map drew **GFS**, because the API's `auto` picks the newest analysis covering the viewport (GFS lands ~3.5 h after its run, ECMWF ~8.5 h). **THE API HAS ALWAYS SUPPORTED `source=ecmwf|gfs|hrrr` AND THE READER HAD NO WAY TO ASK FOR ONE** — a choice the reader cannot make is a mystery, and a mystery is a bug report. **There is now an ANALYSIS PICKER**: a third chip row in the isobar legend (**Auto · ECMWF · GFS · HRRR**), which **refetches** (three analyses are different data, not different paint), persists in `localStorage["xyzo.isobarSource"]`, and travels with the link (`/isoSrc=ecmwf`), the saved style and the presets — the same grammar a shared URL speaks. It is written **always** when the isobars are on, for the same reason the step and the colour are: omitting it leaves the READER's stored choice to decide. **The requested analysis and the SERVED one are different things** — HRRR only covers North America, and an analysis that is not loaded falls back to the newest global one — so the layer keeps both, and the attribution always names the one actually drawn. **AND A CHIP FOR AN ANALYSIS THAT IS NOT PUBLISHED IS DISABLED**: there is **no HRRR worker** (nothing has ever published an HRRR isobar row), so the layer asks the API what it actually holds (`/api/weather/isobars/meta`) and greys that chip out with *"Not published right now — no worker builds this one yet"*. A chip that offers an analysis and then silently draws something else is exactly the half-truth this repo is written against. Verified live: the HRRR chip is disabled, clicking it does nothing, and a link asking for `isoSrc=hrrr` falls back to GFS with the chip saying *"the map is drawing NOAA GFS 0.25° instead"* and the attribution naming GFS. **The globe reads it too** (`globeIsoSource()`), because the 2D↔3D handoff passes unknown hash parts through untouched. Verified live: clicking ECMWF serves `ECMWF IFS 0.1°` at 12Z, clicking GFS serves `NOAA GFS 0.25°` at 18Z, the hash follows, 0 console errors. Tests: `isobar-source.bun.test.js` (7 new). |
| 🕐 **"The climate maps haven't changed in 24 hours" — they had, and the freshness is provable** | 🔎 verified (11-04) | Owner report: *"temperature maps pressure maps it seems they havent' changed in 24 hours"*. **THEY HAVE.** Measured 2026-11-04 20:55 PST: the **wind** was rebuilt at 14:55 from the **GFS 2026-11-04 18Z** analysis, the **temperature** at 18:42 from **18Z**, and the **isobars** at 18:29 from **18Z** — the isobar API answered `run_time: 2026-11-04T18:00:00Z, source: gfs`. All three re-fetch on their 6-hourly timers and the files are written within a minute of each cycle. **THE BROWSER IS NOT SERVING A STALE COPY**: `/data/*/meta.json` and `/data/*/grid.bin` answer **200 with an ETag and a `Last-Modified`** and no `Cache-Control: immutable` (the immutable year is for `*.png` only), so they revalidate. **WHY IT LOOKED STATIC:** a 6-hourly GFS analysis over the same air masses genuinely does not move much, and the *temperature* overlay's ramp is **adaptive** (the 2nd/98th percentile of the run, rounded to 10 °C — so the colours shift a little each cycle without the field shifting), so consecutive cycles look near-identical. **THE THREE TIMERS ARE INDEPENDENT**, so one overlay can be a cycle behind the others for a few hours after a GFS run is published — `worker/gfs_verify.py` says so in a WARNING, not a failure. **THE OCEAN CURRENTS ARE THE ONE THING THAT REALLY IS FROZEN** — and that is on purpose (README Q-N1: the OSCAR mirror stops at 2014-09-26, and the build now REFUSES to publish a composite older than 45 days and alarms daily). |
| 🌊 **The ocean currents stopped off the African coast — and the "live" field was TWELVE YEARS OLD** | 🔎 diagnosed (11-04) | Owner report: *"did you notice that the Ocean currents (live) stop just off the coast of africa?"* **THE GAP IS THE SOURCE, NOT THE LAYER.** OSCAR's surface velocity is an **altimetry inversion**, and satellite altimetry has no valid solution in shallow, river-influenced water — the northern Gulf of Guinea (the Bight of Benin) is exactly that kind of water, so the product leaves it empty and the currents stop at **6°N**. **Our build was checked CELL-FOR-CELL against the raw NetCDF: 0 value mismatches**, so nothing was dropped here. The **daily NOAA CoastWatch geostrophic product** (`nesdisSSH1day`, 2026-09-28) was fetched and measured and has the **same hole in the same cells** — this is the DATA FAMILY, and no amount of client work fills it. **THE REAL FINDING IS WORSE: THE FIELD IS FROM 26 SEPTEMBER 2014.** The ERDDAP that serves OSCAR was loaded in **February 2015** and carries **nothing newer** (117 files, `oscar_vel7001`…`oscar_vel8026` = 2011-12-06 → 2014-09-26; no pagination, no newer name), so the **daily timer had been re-publishing the same twelve-year-old field** since the overlay shipped — and **every physics gate passed it, because no gate ever looked at the DATE**. Three changes: **(a) `verify()` gained a FRESHNESS GATE** — a composite older than **45 days** is refused and the build exits non-zero, so the timer alarms every day until a fresh source is configured; **(b) the legend shows the composite's own date and its age** ("2014-09-26 · 12.1 years old — NOT live"), which is what README Q-N1 already claimed happened and **it did not**; **(c) the layer's name is now "🌊 Ocean currents (OSCAR)"**, because a checkbox that says "(live)" beside a legend that says "not live" is exactly the half-truth this repo is written against — the **URL slug stays `ocean-currents-live`** (the owner's own links and the Earth-portrait preset use it, and an identifier is not a claim of freshness). **THE COASTAL GAP IS NOW EXPLAINED IN THE LEGEND** instead of looking like a bug, and the measured coverage (**44.6 %** of the Gulf of Guinea box) is published in `meta.json`. **A FRESHER, PHYSICALLY-WRONG ALTERNATIVE WAS MEASURED AND REJECTED**: the daily absolute-geostrophic field has a **spurious eastward jet at the equator** (+0.69 m/s at 6°N, where the South Equatorial Current must flow **west**; OSCAR gives −0.37 m/s at 5°S) — the classic `g/\|f\|` blow-up of an absolute geostrophic velocity near the equator — so swapping it in would have traded a visible coastal hole for an invisible equatorial error. **AND THE SERVICE WORKER WAS HIDING IT**: `/data/*` is **cache-first**, so a returning reader's cached `meta.json` — the one without `source_date` — would have silently dropped the whole age line and put the lie back. A `meta.json` now goes **network-first** with the cache as the offline fallback (it carries the PROVENANCE, so a stale copy of it is a lie the reader cannot see); the big grids are still cache-first. Tool: `scripts/ocean_current_audit.py` (**8 scenarios**, the 8th checks the legend tells the truth); tests: `ocean-current-layer.bun.test.js` (**29**, 9 new) and `offline-layer.bun.test.js` (**24**, 3 new). |
| 🌊 **Firefox froze the ocean currents — and the layer had three dead controls besides** | ✅ fixed (11-04) | Owner ask: *"can you check that firefox works with the Ocean currents (live) — we might be having an issue."* **THE FLAT MAP WAS FINE AND THE TAB WAS NOT.** The layer loads, animates at 40-60 fps and survives the preset, a shared link, a checkbox click, a pan, a cold cache, a slow network and the service worker — **measured in Firefox and Chromium alike**. The fault was in what happens when the reader **switches tabs**: `step()` returned early on `document.hidden` **before** the `finally` that re-schedules the frame, so the chain was never re-armed — **and nothing else ever re-armed it**. **Firefox KEEPS FIRING `requestAnimationFrame` in a background tab (throttled to ~1 Hz) where Chrome SUSPENDS it**, so in Firefox the first background frame ran, hit the branch, and the animation was **dead for good**: the reader came back to a frozen map. Chrome never saw it because its suspended rAF means `step()` never runs at all while hidden. The wind layer has had the guard and a `visibilitychange` handler since 10-29; this layer was written later and missed both. `schedule()` now refuses to hold a frame while the tab is hidden, and a `visibilitychange` handler pauses and **restarts** it — the same pattern the wind layer uses. **The globe's `globe-wind.js` had the identical shape** (it serves the globe's wind AND its ocean currents), so it is fixed the same way. **AND THE LAYER HAD THREE DEAD CONTROLS**, all found while looking: **the legend was NEVER MOUNTED** — `mountLegend()` was written and exported and **nothing ever called it**, so the reader had no speed key and the **Probe** button and the **Streamlines/Arrows** chips were simply not on the page (the CSS for the legend has been in `styles.css` since the layer landed); **the Probe was dead anyway** — `showProbe()` was never called from anywhere, so arming it did nothing; and **the "Arrows" style was dead** — nothing ever read `state.style`, so the chip changed the button and not the map. All three now work: the legend mounts into the layers dropdown (retried until the control exists, then re-mounted when the published ramp arrives), the probe reads Leaflet's own `e.latlng` and owns the click while armed (app.js's click-to-submit guard checks it), and the arrows renderer draws one glyph per cell with the length carrying the speed and the head the direction. Tool: **`scripts/ocean_current_audit.py --browser firefox`** (seven scenarios: preset, link, checkbox, pan, **background tab**, probe, arrows). Tests: `ocean-current-layer.bun.test.js` (20, of which **3 run the module** — a hidden tab must not hold a frame, and the tab coming back must restart the chain; both **mutation-checked**). Suite: **1362 pass / 0 fail**. |
| 🖼️ **The image proxy still answered 404 on three paths — and the console said so** | ✅ fixed (11-04) | Owner report: *"image-proxy:1  Failed to load resource: the server responded with a status of 404 ()"*. The proxy had been changed to answer a dead picture with **HTTP 200 and a 1×1 transparent PNG** — but **three paths still answered a 404 JSON**, and one of them even carried a comment saying that *"404 keeps the browser console quiet"*. That is **backwards**: a 404 on an `<img>` **IS** the console noise the endpoint exists to remove — the browser logs every failed subresource and **no JavaScript can suppress it**. The three paths: **(1) A HOST THAT NO LONGER RESOLVES** (a publisher whose domain expired) answered `{"error":"host_unreachable"}` with a 404; **(2) A NETWORK ERROR OR TIMEOUT** answered `{"error":"fetch_failed"}` with a 404; **(3) AN UPSTREAM 200 WITH AN EMPTY BODY** answered `{"error":"no_body"}` with a 404 — and the **negative cache** then handed back that same status on every later request, so a dead publisher's dead domain kept filling the reader's console for half an hour. All three are now the **placeholder**, and the cached failure is too (the one exception is a cached **400**, which is about the *request*). **AND THE RATE LIMIT WAS THE SAME SHAPE.** It was **60 requests a minute, PER IP** — and **an IP is not a person**: a mobile carrier's CGNAT puts thousands of readers behind one address, so one reader's burst of images (a page load asks for ~15) starved everyone else behind that address, and every image they then lost was another console error. The limit is now **300/minute**, and the two kinds of caller get **two different answers**: a **browser asking for an image** (its `Accept` says `image/*`) gets the **placeholder** with `Retry-After`, because a rate-limited *reader* can neither silence the error nor act on it; only a caller that **explicitly asked for JSON** still gets the **429** — it can actually back off. (This endpoint exists to serve images, so an image-shaped answer is the right default.) Measured with the new `scripts/image_proxy_audit.py`: **14 image-proxy responses on a live page load — all 200, no console errors**; and **400 stored image URLs probed — all 200, with a handful genuinely dead at the publisher** (`static.klix.ba`, `api.romania-insider.com`), each answered with the transparent placeholder. The rate limit was measured too: **340 requests as an `<img>` caller → 340 × 200**, and the same burst as a JSON caller → **429**, so the browser path is silent and the API path is honest. Tests: `api/tests/image-proxy.test.ts` (6 new), including one that asserts the endpoint may answer **200 or 400 and nothing else**. |

| 🎓 **A "how to" tour for a first visit — and for anybody who asks** | ✅ shipped (11-04) | Owner ask: *"we might want to build a 'how to' or a 'demo' of how all our features work when people first visit or ask for help."* A map with thirty-odd overlays, a live feed, a globe, an export dialog and a control menu cannot be explained in a paragraph, and nobody reads a manual. New **`public_html/tour.js`** walks a reader through it in **six steps**, each one pointing at the **real control it talks about** — the layers dropdown, the search bar, the live panel, the 3D-globe button, the ⚙ menu — so the reader is looking AT the thing while it is named. It shows itself **once**, on a first visit, and remembers that it did (`localStorage["xyzo.tourSeen"]`); it is also a **button**, in the ⚙ menu (TOOLS → *How to*) and in the help panel (*Show me how this works*), so **"ask for help" can be answered by SHOWING rather than telling**. The rules that make it a good guest: the **spotlight never swallows a click** (the cut-out is `pointer-events: none`, so the reader can press the very control the step is describing), the card is **escapable** (Escape, the ✕ and Skip), it **never moves the map** (the steps describe what is already on screen — flying the reader somewhere else would be a second thing happening at once), and below 640 px it becomes a **sheet** at the bottom with the safe-area inset, because a floating card on a 390 px screen covers the control it is describing. The **placement is measured, not guessed**: the card goes beside the target in whichever direction has room, and the audit asserts it **never overlaps** the control it describes. A **shared link does not trigger it** — that reader was given a map by somebody and did not arrive to be shown the controls — and the decision is made on the hash **as it arrived** (captured at module level, before the map writes its own: the default map is a preset, and the preset becomes the URL, so reading `location.hash` later would mistake a first visit for a shared link). Verified with `scripts/tour_audit.py` (a real browser): it shows itself, every step has text, the spotlight lands on its target, the card never covers it, Next/Back/Skip work, it does not come back, the ⚙ menu replays it, a shared link does not trigger it, and it survives a resize. Tests: `tour.bun.test.js` (18 new). |
| 🛰️ **The NASA overlays no longer fill the console with 404s — and the satellite actually renders** | ✅ fixed (11-04) | The NASA GIBS overlays (the rain rate, the true-colour satellite, the night lights) were fetched **straight from GIBS**, and GIBS answers **HTTP 404** for every tile where the product has no value — the open ocean and the poles for the rain, the poles for the satellite. **A 404 on a tile is a 404 on an `<img>`, and the BROWSER logs it** — no JavaScript can suppress a message the network layer produced — so every first visit filled the console with red lines that said nothing useful. **AND THE TRUE-COLOUR SATELLITE WAS RENDERING NOTHING AT ALL**: the client asked GIBS for *yesterday* (`nasaDate(1)`), and GIBS publishes that product a day or two behind — every tile 404'd, the layer's checkbox said "on", and the map drew nothing. New **`api/src/routes/tileProxy.ts`** serves `/api/tile/:dataset/:date/:z/:y/:x` and applies the same rule the image proxy already uses: **a missing tile answers HTTP 200 with a 1×1 transparent PNG**, so the console stays clean. The URL is built **server-side from a whitelist** — there is no `?url=` parameter, so the route has **no SSRF surface at all**. It also **resolves the most recent PUBLISHED date**: the proxy asks GIBS for a canary tile (a fixed one over central Africa, which every one of these products covers) and walks the date back until one answers, then serves the whole layer from that date — so the satellite is no longer blank, and the picture is one consistent day rather than a seam of three. **GIBS IS FLAKY** (the same tile URL answered 404, 200, 200, 404 across four identical requests — a CDN with more than one origin), so a 404 is retried before it is believed: without that, a tile that *does* exist is served blank and the date probe walks back a day for no reason. The **extension is per dataset** (the true colour is JPEG, the rain and the night lights are PNG) and the **zoom range is enforced** (GIBS answers 400 for a level its matrix does not have, and a 400 is a console error too). Both views now go through the proxy — the flat map and the globe — so **the console on a first visit is clean**: measured over three fresh loads, **no 4xx and no console errors at all**. Tests: `api/tests/tile-proxy.test.ts` (10 new). |
| ⭕ **The pin renderer was still creating — and removing — its OWN ring** | ✅ fixed (11-04) | The shared hover ring (`public_html/hover-ring.js`) is **one element for the whole map**, and the ring work made every point overlay ask it to move. But the pin renderer kept a **fallback**: if `hover-ring.js` was not on the page it built its **own** `.xyzo-pin-hover-ghost` — a **second element with the same class**, which is exactly what the one-ring rule forbids (two circles could be on screen at once, and a query for the class could find the wrong one). Worse, its `disable()` called `this._ghost.remove()` — and the element it held **was** the shared one, so **switching the markers layer off deleted the ring from the earthquakes, the faults and the language regions too**. There is now **no fallback**: the renderer asks `HoverRing.el()` and, if the shared module is missing, says so in the log instead of making a duplicate. `disable()` **hides** the ring, it does not remove it. Pinned by a test that asserts the class is never created and `.remove()` is never called on it. |
| 🧭 **The API-path guard now understands route PARAMETERS** | ✅ fixed (11-04) | `scripts/check-api-paths.sh` diffs every `/api/…` literal in `public_html/` against the routes registered in `api/src/`, and it refused the new tile proxy: the client asks for **`/api/tile/rain`** (the date and the tile numbers are built at runtime) and the route is **`/api/tile/:dataset/:date/:z/:y/:x`** — the literal `rain` **is** the `:dataset`, and the route carries four more segments the frontend literal never spells out. The old matcher only accepted a *literal* route prefix, so it called the tile path a **silent 404** — and the deploy gate (`validate-api.sh`) **failed**, which took the API **down for 13 minutes**. The matcher now compares **positionally**: a route segment that is not a parameter must equal the frontend's, a `:param` may stand for any one segment, and the route may carry extra segments **only if they are all parameters**. The rule is strictly *additive* — it can only turn a non-match into a match, so nothing that passed before can fail now. The old lenient rule stays as a fallback. |

| ⛅ **Pick the colour of the pressure lines** | ✅ shipped (11-04) | Owner ask: *"can we have a way to select the color of the pressure lines near the detail switch — for example red is easy to see… or various random styles?"* A second chip row now sits **directly under the 1/2/4/8/16 hPa detail switch** — same markup (`.soil-prop-switch` / `.soil-prop-btn`), so there is no new CSS to collide with — carrying **six** choices, each with a **DOT** showing what it looks like so the reader picks by looking: **By pressure** (the classic diverging key — the default, because the colour is the chart's key), **Red / White / Black** (one bright or dark INK for a basemap that swallows the lines — the pressure is then read from the labels and the probe), and **Rainbow / Turbo** (ramps from the site's own `ramp-styles.js`, so the pressure stays in the hue). The choice lives in `localStorage["xyzo.isobarColor"]` **and in the URL**: `iso=<step>` became **`iso=<step>:<colour>`**, written **always** (not only when it differs from the default) for the same reason the step is — omitting it would leave the RECEIVER's stored scheme to decide, so a sender on "By pressure" would hand a receiver on "red" a link that opened in red: the same map, different lines. A link's colour is a **VIEW** (`setColour(…, { persist: false })`), so opening someone else's map never overwrites your own scheme. Changing it **REPAINTS, it does not refetch**: the level rides on each polyline (`options.level`) and `repaintLines()` re-reads it from the new scheme, dropping the cached `colourStops` first so the second chip is not a no-op. **The globe means the same thing by the same token** — `globe.html` now loads the shared `ramp-styles.js` (added to `bump_frontend.sh`'s globe stamp loop, or its token would have gone stale), `ISO_INKS` mirrors the flat map's three hex inks, and its hash writer emits `iso=<step>:<colour>` too, so a shared link is exact in **both** views. The row is built by `mountColourControl()` **from `mountStepControl()`** — app.js never mentions it (second source of truth). **A `const` below its use is in the temporal dead zone**, and `COLOUR_CHOICES` shipped below the `state` literal that calls `readStoredColour()` — the whole module failed to evaluate and the layer was silently dead (see the row below); the list now sits above the literal and a test pins the **source order**, because that is exactly the bug a runtime test only catches by loading the page. Verified live (Playwright): six chips mount under the detail row, clicking Red moves the polyline to `#ef4444` and the hash to `iso=4:red`, and a second reader opening that URL comes up on the same scheme with a **byte-identical** hash. Tests: **`isobar-colour.bun.test.js` (26 new)**. |
| 🌍 **The default map is now the map the owner pasted** | ✅ shipped (11-04) | Owner ask: *"okay something like this map would be nice for our default 'normal mode' when they first load xyzo.org or also if they click on [the 🌍 Earth portrait chip]"* — with their link: `#17.3926,9.1406,3/density=max/overlay=koppen@20,wind-gfs@100,population-density-worldpop-1-km@20,soil-soilgrids@20,cropland-esa@40,land-cover-esa@15,rivers@100,basins@100,geology-macrostrat@25,ocean-currents-live@100,isobars@100,nasa-rain@55/iso=1/wind=particles:colourful`. **The "Earth portrait" preset's hash is now THEIRS, verbatim** — and since that preset *is* the first-visit showcase (`COOL_ID.high`), **a bare xyzo.org opens on exactly that map** (verified live: the URL it opens at is their link, with all **twelve** overlays on). What changed against the 2026-11-03 version: the **geology**, the **live ocean currents** and the **NASA rain** came in; the **isobars** went to their full strength; and the heavy washes — population 100 → 20, soil 40 → 20, cropland 85 → 40, land cover 25 → 15 — dropped right back, so **the wind and the rain read THROUGH them** instead of being buried. The wind-speed field is gone: the owner wants the **animation**, not a wash under it. The centre moved to central Africa, where the Congo basin's rainfall, the equatorial currents and the geology all show at once. **SUPERSEDED ON 2026-11-08 — see the row at the top of this table: the default map is the owner's own FIFTEEN-overlay link** (the geology and the 2014 ocean currents are out; the soil TYPE, the relief and the tectonic faults are in; the isobars are at 0.25 hPa off GFS). The preset's slug for the currents did not change, so every link naming it still resolves. |
| ⛅ **The pressure lines were DEAD on the flat map — and the module never ran** | ✅ fixed (11-04) | Found while applying the new default: the preset's `isobars@100` **did not switch on**, and the reason was a **temporal dead zone at module load**. The state literal calls `readStoredColour()`, which reads `COLOUR_CHOICES` — and `COLOUR_CHOICES` was declared **below** the literal. A `const` below its use is in its TDZ, so `isobar-layer.js` threw *"Cannot access 'COLOUR_CHOICES' before initialization"* **as it loaded**, and **not one line of it ever ran**: no `window.IsobarLayer`, no layer, no isobars. The error was invisible because the layer's own failure handler swallowed it and the console-guard let it by. **The whole isobar layer has been dead on the flat map** while the globe (which has its own copy of the ramp) kept drawing. Fixed by declaring the list above the literal, and pinned by a test that asserts the **source order** — because a source-order bug is exactly what a runtime test would only catch by loading the page. |
| 🌊 **The currents had a poisoned cache** | ✅ fixed (11-04) | The ocean-current layer seeds its particles from the grid's **wet cells**, and the list is cached — but **an empty array is truthy**, so the first call (from the moveend handler, which fires **before** the grid has loaded) cached "nothing yet" and the list was **never rebuilt**. The layer switched on by a **preset or a link** seeded **zero** particles; the same layer switched on by a **click** (after the data arrived) worked. Only a *built* list may be cached, and the data load resets it. |
| 🧪 **Four stale tests, and one that asserted a COMMENT** | ✅ fixed (11-04) | `isobar-step.bun.test.js` had fallen behind the isobar-colour feature: it still expected four steps, `iso=<step>` without a colour, and the globe writing `` `/iso=${isoStepInUse}` `` rather than the step **and** the colour. Worse, one of its tests sliced `app.js` from the **comment** "The DETAIL step first" — and when that comment was reworded the slice started at **−1**, so the test asserted against the **last character of the file** and passed or failed for the wrong reason. The tests now anchor on **code** and use plain substrings. |
| ⛅ **The isobar audit was reading the WRONG pressure field — and blaming the isobars for it** | ✅ fixed (11-04) | `worker/gfs_verify.py::isobar_check()` rebuilds the pressure field the published lines are checked against. It rebuilt it from the **1°** GFS product, because `fetch_raw()` asked the filter server for `1p00` — **but the isobars on the map are contoured from the 0.25° PRMSL** (`worker/isobars.py`: `GFS_PRODUCTS` tries `0p25` first and falls back to `1p00` only if the filter server cannot serve it). Two grids — and the 1° one is additionally blurred **four times as hard**, because `smooth_field()`'s sigma has a **floor of two CELLS** (`max(2.0, 0.5°/spacing)`): that is 0.5° of blur on the 0.25° grid and **2.0°** on a 1° one. So the audit compared 0.25°-contoured lines against a 1° field blurred twice as wide — a **false alarm**, and a loud one: measured on the 2026-11-04 18Z analysis the GFS p95 offset came out at **1.355 hPa** against the 1° field, where the 0.25° field gives **0.029 hPa** — **45× worse**, and 100× worse than ECMWF (0.011 hPa), which had been checked against its own 0.1° field all along. **THE ISOBARS WERE NEVER WRONG; THE AUDIT WAS MEASURING THE WRONG FIELD.** The fix is one resolution: `fetch_raw()` takes the product as an argument (**the wind and temperature checks keep `1p00`** — their published grids *are* 1°), and a new `fetch_raw_isobar()` asks for the source's own grid — **GFS `0p25` first, `1p00` only as the worker's own fallback**, ECMWF its IFS 0.1° message. The blur is still the **worker's own** `smooth_field()` (not a second implementation — a second sigma is a second source of truth, and the one that drifts is the one nobody checks), and the report now says which grid and which sigma it used (`grid_deg` **0.25** / `smooth_sigma_cells` **2.0** for GFS, **0.1** / **5.0** for ECMWF). **THE GATE HAS TEETH, AND IT NOW HAS THE RIGHT CALIBRATION.** The published tolerance was **p95 > 2.5 hPa**, on the reasoning that the contouring moves a line "by up to the grid spacing — over high terrain that is a couple of hPa". **It does not.** The Chaikin amplitude is ~0.06° and the Douglas-Peucker tolerance 0.01°, so the contouring moves a line by ~0.07° — a third of a cell at 0.25°. Measured on the field each source's lines were cut from, over three GFS cycles (06/12/18Z), five boxes and the steepest terrain on Earth, the artefact is **p95 0.029–0.048 hPa** (GFS) and **0.011–0.018 hPa** (ECMWF) — so the old 2.5 hPa allowance was **52× the artefact**, and the gate could not notice a displacement of a whole grid cell. The tolerance is now **0.4 hPa** (8× the worst measured artefact, 13× the default box's 0.029), and it catches **everything it used to catch, plus the single-cell displacements it used to miss**. Measured on the 2026-11-04 18Z lines, each mutation's p95 and whether the gate now fires: **unbroken 0.029 → pass**; **one 0.25° row shifted 0.698 → FAIL** (the old gate passed it); **one 0.25° column rolled 0.491 → FAIL** (the old gate passed it); **the 1° field instead of the 0.25° one 1.355 → FAIL**; **a level 1 hPa out 1.003 → FAIL**; **the wrong cycle 6.2–14.5 → FAIL**; **the field mirrored about the equator 12.0 → FAIL**. The mean gate (0.25 hPa, unchanged) is the backstop for a systematic bias; the measured mean is +0.002…+0.008 hPa. Tests: **`worker/tests/test_gfs_verify_isobars.py` (16 new)** — including a live test that displaces the **real published** lines by one row and one column and asserts the gate fires — plus the live check in `test_gfs_verify.py` now asserts the gate's own constants, so the test and the gate cannot drift apart. |

| 🌊 **The ocean currents were running but invisible — and the console was full of dead pictures** | ✅ fixed (11-04) | Owner report: *"im not seeing the waves move… also some errors /api/image-proxy?url=…infomoney…/Kyambogo-rest-room.jpg:1 Failed to load resource: the server responded with a status of 404 ()"*. **TWO faults, and the first one was the wind's old mistake again.** **(1) THE RAMP STARTED NEAR-BLACK.** The median ocean surface current is **0.11 m/s** and most of the ocean is slower than 0.3 m/s, so a ramp whose first stop was `#0b1020` painted the great majority of the ocean in a colour indistinguishable from a dark satellite basemap: the canvas existed, the particle loop ticked, the frame counter advanced — **and the reader saw nothing.** The ramp is now **bright at both ends** and is **published** in `meta.json`, so the flat map and the globe read the *same* ramp. (The wind had the same fault and the same fix — a ramp with a dark end is invisible on a dark map.) **(2) THE PARTICLES WERE SEEDED BY PICKING RANDOM SCREEN PIXELS** and rejected unless the water there was moving — so a view over a continent seeded almost nothing. They are now seeded from the grid's **wet cells** (1,136 particles instead of 172, and the field is visible over the whole ocean). **(3) THE CONSOLE NOISE WAS THE PUBLISHER, NOT US.** Both URLs in the report are **genuinely dead at the source**: `www.infomoney.com.br/dependent/…` answers **404** and `fajar.co.id` answers **403** (hotlink protection) — verified with a direct request. An `<img>` that 404s is a console error the reader can neither silence nor act on, and **two publishers account for thousands of dead links** (499 rows and 5,389 rows in the database). So the image proxy now answers a missing picture with **HTTP 200 and a 1×1 transparent PNG** — the browser loads it happily, the `<img>` paints nothing, and **the console stays clean**. The client hides a placeholder-sized image on load (it checks `naturalWidth`), so **the layout is exactly as it was** when the image used to fail. A healthy image is still served as the image itself (verified: 663 KB JPEG). The malformed-request (400) and our own rate-limit (429) stay errors — those are about the request, not about a missing picture. |

| ✖️ **The "Map imagery isn't loading" notice can be sent away** | ✅ shipped (11-04) | Owner ask: *"can we have a way to X out this message its getting in the way."* The notice sits across the **top of the map**, so it is in the way of the very thing it is talking about — and it is a **notice, not a blocker**: nothing on the page depends on it. There is now an **X** on it (a real `<button>`, so it is focusable and announced, with a 44 px touch target on a coarse pointer). **Dismissing it also stops it coming back**, which is the half that matters: the tile watcher fires on **every failed batch of tiles**, so a dismissed banner that reappeared ten seconds later would be worse than no button at all. The dismissal is remembered for the **session** (`sessionStorage`) and **forgotten as soon as the situation resolves** — the tiles come back, or the connection returns — so a genuinely **new** outage warns the reader again. All three wordings carry the X — "Map imagery isn't loading…", "You're offline…" and **"The map didn't load."** (added 11-06) — and they **share one dismissal key**, so sending away any of them opts out of the rest for that session (Q-N19(a)). **The audit's trap is worth recording**: `scripts/offline_notice_audit.py` had to route at the **CONTEXT**, not the page. The **service worker takes control of the page** and serves the tiles itself, and a request made *by the worker* does not go through a page route — so 20 of the 24 tiles reached the real network, **loaded**, and the page saw only four failures instead of the twenty a real outage produces. Four is below the watcher's threshold of eight, so the notice never appeared and the audit cheerfully reported "no button" for a notice that was working perfectly. Tests: `offline-notice-dismiss.bun.test.js` (7 new). |

| 💨 **The globe's wind: the animation and the speed field now actually work** | ✅ fixed (11-04) | Owner ask: *"can we get the wind animation and also the wind speed overlay for the 3d globe whats going on with that?"* Both entries were in the panel with the right defaults — and **the animation was wired to the wrong thing**. **THE GLOBE HAD ONE CONTROLLER FOR TWO ANIMATIONS.** The wind and the ocean currents are both "a canvas over the map", so both asked for a controller — and both wrote it into the **same variable**. The second one created (the ocean currents) **overwrote** the first (the wind), so switching **"💨 Wind (GFS)"** on switched the **ocean currents** on instead, and the wind never animated at all. The controllers are now a **map keyed by the overlay**. **AND THE READER WAS TOLD NOTHING, because the globe had NO LOGGER**: `console-guard.js` (which defines `window.XLog`) was loaded on the flat map and **not on the globe**, so every failure in every globe module was completely silent — the overlay simply did nothing and the console said nothing either. The globe loads the logger now. **Measured on the live globe** (`scripts/globe_wind_audit.py`): the speed field changes the picture (the centre pixel goes from `(2,44,64)` to `(7,93,131)`), the animation's canvas draws and keeps drawing (25 → 32 lit samples over 2.5 s), and the switch reaches **the wind's** controller — `{'wind': True, 'ocean-current': False}` — with the ocean currents left off. The speed field is a **Mercator**-baked image, exactly like the temperature, so it sits in the right place on the sphere. **The audit's own trap is worth recording**: its first version matched the panel row with `indexOf('Wind (GFS)') === length - n`, which is **true for any row that does not contain the label at all** and happens to be the same length — so it switched the **RIVERS** on and reported that the wind did nothing. Tests: `globe-wind.bun.test.js` (8 new). |

| 🖱️ **The mouse pointer: a ring on EVERYTHING, and a canvas that was eating the map** | ✅ fixed (11-04) | Owner ask: *"is the 'mouse over' working and doing a circle around the story or earthquake or whatever.. we need to kinda study whats going on with the mouse pointer in playwright and correct all those types of problems."* **A Playwright study of the real pointer** (`scripts/hover_audit.py`) found **five** faults, and the biggest one was silent and total. **(1) A LEAFLET CANVAS RENDERER WAS SWALLOWING EVERY POINTER EVENT ON THE MAP.** `L.canvas()` puts its container in the **default overlay pane** — which is exactly where the **story-pin canvas** lives — so the earthquake layer's renderer was appended *after* the pin canvas and sat **on top of it**, and a canvas is a full-map element with `pointer-events: auto`. The consequence: **the moment the earthquakes (or the language points) were switched on, the story pins' own hover died** — no ring, no card, nothing. The renderer must be told its pane (`L.canvas({ pane: PANE })`), and the pane's CSS is `pointer-events: none`, so it paints without being seen by the pointer. **(2) THE RING WAS THE PIN RENDERER'S PRIVATE ELEMENT.** The earthquakes, the faults and the language regions had **no ring at all** — pointing at one showed nothing. There is now **ONE** ring (`public_html/hover-ring.js`), and every point overlay asks it to move, so there is never more than one circle under the cursor. **(3) THE HOVER CARD ONLY KNEW ABOUT STORY PINS.** In the default "pins" mode it showed the card only over a pin, so an earthquake under the cursor produced silence. The card now takes a **generic target** from any layer (`HoverInfo.setTarget`), and the earthquake pushes *"M 4.2 · Bonin Islands, Japan region · 2 h ago · 429 km deep"*. **(4) THE GLOBE HAD NO RING.** Its first attempt used a map-wide `queryRenderedFeatures`, which **does not report the features under the cursor on a sphere** — it uses the **layer's own** `mousemove` now. **(5) TWO SMALLER ONES**: the earthquake's age printed **"20761 d ago"** (the epoch, not the age — `relativeAge()` takes an age, and it was handed the timestamp), and the cursor stayed a **pointer** after the pointer left the canvas. **The study's own trap is worth recording**: the first version of the audit reported the hover as *completely broken*, and it was wrong — it picked the first pin the API returned, and that pin was often **under the layers dropdown**, so the pointer moved onto the dropdown rather than the map. A hover study must only count a point the pointer can **reach**, which is why the audit now asks `document.elementFromPoint()` first. Measured after the fix: the story pin shows a 24 px ring + the card + a pointer cursor; the earthquake shows a 26 px ring + the card; the empty map clears both; the globe shows a ring + a pointer cursor. Tests: `hover-ring.bun.test.js` (11 new). |

| 🌡️ **The 3D globe's temperature, lightning and magnetic wash were in the WRONG PLACE** | ✅ fixed (11-04) | Owner ask: *"the temperature map still doesn't look correct for 3d? … lightning density looks wron too"*. **The cause was one shared mistake, and it was not the data.** MapLibre's `image` source is a quad whose four corners are given in lng/lat — and MapLibre turns those corners into **MERCATOR** coordinates and stretches the texture across that mercator rectangle. The globe baked the texture in **LATITUDE** (row 0 = +90°, rows linear in latitude) and then draped it as if it were mercator, so **every latitude except the equator was sampled with the wrong row**. Measured on the 2026-11-03 cycle by projecting known points and reading the painted pixel back: at **45°N the globe painted 38 °C — the Sahara's heat — instead of the Bay of Biscay's 11 °C, 27 °C too warm**, and the poles came out hot. The lightning climatology was worse: the Congo and the Amazon hotspots were smeared across the wrong latitudes, which is why the globe looked like one orange ball. **The fix is a shared bake, not a patch**: new **`public_html/field-bake.js`** owns the canonical **Web-Mercator** bake and the ramp, and the temperature, the lightning and the magnetic wash all use it — which also makes the globe show the **same picture as the flat map**, because the flat map's tile grid is Web Mercator too. The flat map's `temp-layer.js` now reads the same ramp and the same `tileLat()`, so there is **one implementation, two views** and no second source of truth to drift. The picture's quad is now the mercator world (corners at ±85.051129 — at ±90° the projection is `y=Infinity` and the source silently never renders). Verified live by reading painted pixels back: at 0°, 45°, −45°, 90°E and 20°N the globe now agrees with the published grid to within a few RGB units, and the globe shows a textbook temperature map (blue poles, green mid-latitudes, red tropics, a cold Andes). |
| 🌐 **Earthquakes: all 30 days / 7 days / 24 hours / 1 hour, with details** | ✅ shipped (11-04) | Owner ask: *"we want 'all earth quakes past 30 days, 7 days 24 hour and last hour… save it so we don't have to constantly poll usgs… we also need to color our earthquakes and change a different type of circle for each size of earthquake as well as red for recent earthquakes orange yellow and maybe even other colors based on time of earthquake so a larger circle for larger earthquakes."* **The catalogue is ours now, not the USGS's.** `scripts/earthquake_build.py` downloads the four USGS ComCat summary feeds and publishes them under `public_html/data/earthquakes/` as four GeoJSON files (hour / day / week / month) plus a `meta.json`; the browser fetches **our** copy, so a reader who opens the map never becomes a client of the USGS feed. A new **`xyzo-earthquakes.timer`** refreshes it every 10 minutes (USGS updates its feeds every minute; the timer runs as the `asher` user and needs no key, no account and no login). **The encoding is the one the owner described**: the circle's **radius grows with the magnitude** and its **colour cools with the age** — **red** under an hour, **orange** under a day, **yellow** under a week, **blue** under a month, grey beyond — and the popup carries the magnitude, the place, the time (UTC *and* local), the depth, the felt reports, the tsunami flag and the USGS event id, with an **"Open ↗" link straight to `earthquake.usgs.gov/earthquakes/eventpage/<id>/executive`**. The **1 h / 24 h / 7 d / 30 d** switch is a chip row, exactly like the soil-property switcher. `verify()` is a gate, not a checkpoint: it checks the South Equatorial Current of the Ring of Fire — that the newest event is inside the hour window, that the month feed has more events than the hour feed, that the coordinates are not swapped, and that every event carries a magnitude and a finite lng/lat. |
| 🪨 **Tectonic faults: the fault traces and the plate boundaries** | ✅ shipped (11-04) | Owner ask: *"let's also try and add 'earth quakes' and the … Active Tectonic Fault Contacts … the USGS hosts pre-packaged, ready-to-use KML layers on the USGS Earthquake Hazards KML Page."* The **USGS Quaternary Fault and Fold Database**'s traces (the San Andreas, the Hayward and every other Quaternary fault in the United States) plus the **global plate interfaces** are converted from the USGS KML into one GeoJSON by `scripts/faults_build.py` and drawn as lines — **33,926 features**, coloured by kind and by the age of the movement, with the most significant faults first so a world view is not a hairball. `verify()` refuses to publish unless the San Andreas, the Hayward and the plate boundaries land in their known places **and** the coordinate order is not swapped (a swap puts the San Andreas in the sea east of Japan). |
| 🌊 **Ocean currents: an ANIMATION, not a picture** | ✅ shipped (11-04) | Owner ask: *"we also need a 'live animated' ocean currents map.. showing flow not just a static image."* **A picture cannot show flow** — the existing overlay is one frozen frame of the NOAA SOS "Perpetual Ocean" field, which shows where the warm water is but carries no direction. So the site now publishes the **direction**: `scripts/ocean_currents_build.py` saves the **OSCAR** surface-current u/v pair (ESR / NASA PO.DAAC, public domain, served through NOAA CoastWatch's ERDDAP — **no key and no login**) as a 1° planar grid, and `public_html/ocean-current-layer.js` **advects particles along it**. The physics are the wind layer's physics, deliberately: longitude **wraps** rather than rejecting, the column past the last one **wraps** rather than clamping, a degree of longitude **shrinks by cos(lat)**, the trail is trimmed by **length** and never by a frame count, and `schedule()` runs from `finally` so one bad particle can never freeze the animation. The canvas is re-anchored on every pan, because the pane's translate persists after a drag and would otherwise carry the whole field off its geography. `verify()` is a gate on the real ocean: the South Equatorial Current must flow **west**, the Gulf Stream must leave the Florida Straits **northward**, the Antarctic Circumpolar Current must be **fast and eastward all the way round** (the ACC *meanders*, so the threshold is 0.7, not 1.0 — a mirrored field scores near zero and still fails), and the Sahara and central Asia must carry **no current at all**. A new **`xyzo-ocean-currents.timer`** refreshes it daily. |
| 🌍 **The languages overlay now has REGIONS, not dots** | ✅ shipped (11-04) | Owner ask: *"we also need to cleanup the 'languages' to have regions not point based where each language is."* The point layer stayed (it is still the honest way to show *where* a language is spoken), and a **new region layer** sits beside it: `scripts/languages_regions_build.py` joins Glottolog's **9,094 languoids that carry a territory** against **Natural Earth 50 m admin-0 countries** and publishes **234 regions**, each carrying the languages spoken there, how many, and the dominant Glottolog macroarea. The result is a region map you can read — Papua New Guinea with 928 languages, the Pacific with one — rather than 8,889 identical dots. The polygons are drawn as a wash coloured by the language count, and the probe lists the languages of the region under the cursor. The **point layer is still there**; the two are two entries in the dropdown, because they answer different questions. |
| 🔭 **The 3D globe now carries the wind, the currents, the earthquakes, the faults and the language regions** | ✅ shipped (11-04) | Owner ask: *"we want the same maps available for both 3g 'globe' as we do for 2d… we especially need 'wind (gfs)' and wind speed as well as soil cropland land cover."* Soil, cropland and land cover were already on the globe; **the wind was not**. The globe's panel now carries **💨 Wind (GFS)** (the ANIMATION, not just the speed field) and **🌬️ Wind speed (GFS)**, plus **🌊 Ocean currents (OSCAR)**, **🌐 Earthquakes (USGS)**, **🪨 Tectonic faults (USGS)** and **🌍 Language regions**. **The wind animation was listed as NOT portable** — *"a screen-space canvas animation tied to Leaflet's 2D projection; particles behind the globe have no meaningful screen position"* — and that reason was **wrong**: the globe's animation keeps its particles in **GEOGRAPHIC** space, projects them with `map.project()` each frame and **culls the far side of the sphere** with a back-face test (the dot product of the point's direction vector with the camera's). A particle behind the globe really has no screen position — and now it is not drawn, instead of being drawn over the front of the planet. The engine lives in **`public_html/globe-wind.js`** and serves both the wind and the currents. The **globe's isobar step**, its **wind speed**, its **temperature**, its **lightning** and its **magnetic wash** all now read the published grids through the shared bake. |
| 🗺️ **Every overlay now works at EVERY zoom** | ✅ fixed (11-04) | Owner ask: *"we want all the map to work at all zoom levels if realistically possible."* Two overlays were **blank at both ends of the scale**: the ocean currents, the sea salinity and the human transportation all said `minZoom: 1, maxZoom: 8`, and a Leaflet `GridLayer` outside its zoom range computes **no tile zoom at all** — so the salinity **vanished on the whole-world view** and **vanished again above z8**, exactly when a reader zoomed in to look at it. All three are now `minZoom: 0, maxZoom: 18`: the source is a 2048×1024 picture, native around z3 and an upscale beyond it, but **present everywhere**. And the **cropland and land-cover pyramids were already deeper than the layers asked for**: z8/z9 tiles sat on disk (116 MB and 431 MB) that Leaflet **never requested**, because `maxNativeZoom` said 8 and 7. The constants now equal the published depth, so a city-level view is a real z9 tile instead of a blurry upscale. |
| 🧭 **The hydrological basins now have a DETAIL switch** | ✅ shipped (11-04) | Owner ask: *"i would like to have 2 main options one for major hydrological basins and another option for 'detailed hydrological basins'."* The builder has published **two detail levels of the same 235 basins** since 2026-10-28 (major 0.05°, detailed 0.01°) and `setLevel()` existed — **but it was DEAD CODE**: it called `refreshLevelButtons()`, which **was never defined**, and `buildLegend()`, which was never defined either. There was no UI at all, so the ReferenceError had never fired. The legend now carries a **Major / Detailed chip row** (the same chips as the soil properties), the missing functions exist, and the choice is remembered. Switching changes the edge detail and **nothing else** — the same 235 basins either way. |
| 🔥 **The 404s in the console are gone** | ✅ fixed (11-04) | Owner ask: *"we are also seeing errors like … /api/image-proxy?url…amp%3Bstrip%3Dall:1 — Failed to load resource: the server responded with a status of 404 () … and we need to clean up all errors."* **Two independent faults, both real.** **(1) THE STORED URLS CARRIED THEIR HTML ENTITIES.** A URL lifted out of an RSS `<img src>` still holds them: `src="…?format=jpg&amp;name=large"` was stored **verbatim**, and the publisher answers 404 for it — Twitter's image host worst of all (**204 of its 205 rows** were broken). `worker/fetch.py`, `worker/image_scorer.py` and `worker/fulltext.py` now `html.unescape` what they extract (`worker/video_discover.py` already did). **(2) A HOSTNAME WAS BEING CORRUPTED, NON-DETERMINISTICALLY.** `_sanitize_image_url()` decided that `www.infomoney.com.br` was malformed — `.br` was not in its TLD table — and cut the domain at `.in` or `.info`, turning it into `www.in` or `www.info` and the rest of the domain into a path. The two candidates **tied on position**, and the tie was broken by the iteration order of a **SET**, which `PYTHONHASHSEED` randomises per process: the same URL became a *different* broken host on every run, and both variants 404. A **two-letter last label is now a valid country-code TLD** (every ISO 3166-1 alpha-2 code is two letters), and the tie-break is deterministic. **39,856 stored rows were repaired** by the new `scripts/fix_image_urls.py` (idempotent, `--dry-run` first); the count of rows still carrying `&amp;` is **0** and the count still on a mangled host is **0**. A third error was the **service worker**: its tile cache is keyed on the URL and ignores the request's **mode**, so an opaque response (what an `<img>` load yields) could answer a later `cors` `fetch()` — which Chromium rejects with *"an 'opaque' response was used for a request whose type is not no-cors"*. An opaque entry may now only answer a no-cors request. |
| 📰 **The live feed: the sources badge now opens the publishers** | ✅ shipped (11-04) | Owner ask: *"we also need to do a full review of our LIVE FEED … and also the ability to select stories and go directly to the source link after seeing a related source.. so for example if you click on 'sources' it does show the sources but we also need to be able to go directly to the website not just zoom into the source pin/marker."* The **"🔥 N sources" badge was a plain `<span>`**, so clicking it bubbled to the item's click handler: the map **flew to the pin** and opened its popup, and a reader who wanted to *read the sources* got a fly-to instead. The badge is now a **button** that opens the source list and **never moves the map**, and every entry in that list carries an **"Open ↗"** link straight to the publisher's own page (plus a count of how many there are). The panel also gained the **options it never exposed**: the API has always accepted `radius_km` (how far "Near Me" reaches) and `limit` (how many stories come back), and the panel hard-coded both to 500 / 30 — so there is now a **Near me** radius (50 m → 2000 km), a **Stories** count (15 → 100) and a **refresh** button, all remembered under `xyzo.liveOptions`. |

| 🌬️ **A "Wind map" preset — and the grammar that can carry one** | ✅ shipped (11-03) | Owner ask: *"can we add a default 'wind map' similar to this one `<link>`"* — the wind animation over the wind **speed** field, the isobars at their finest, and relief/climate/basins for the land. A new chip **🌬️ Wind map** joins the ✨ Cool maps strip. **The link's `/iso=1` segment could not have survived a preset**: `map-presets.js`'s hash parser only understood `base=`, `density=` and `overlay=`, so a preset naming the isobar detail (or the wind's rendering) **silently dropped it** and opened at the reader's own settings instead of the curated ones. Two segments now exist and are honoured end to end: **`iso=<hPa>`** and **`wind=<style>:<colour>`** (e.g. `wind=flow:colourful`) — written by `getMapHash()` (omitted when they are the default, like every other segment, and only when their layer is on), parsed by both `app.js` and `map-presets.js`, applied before the layer is enabled, and carried by `captureStyle`/`applySavedStyle`/`captureMapState` so a ⭐ saved style and the last-used map keep them too. **The preset is zoom 3**, like every other chip, per the owner's rule *"cool maps are GLOBAL views — never zoomed in"* (11-01) — the guard test walks every preset, so a future one cannot quietly ship zoomed in; the owner's centre (23.12, −34.19) is kept. **Also fixed: the isobar step chips lied after a link.** `setStep()` was only repainted by the click handler, so a step arriving from a link or a preset changed the map with **no** click and the dropdown still said "4 hPa" while the map drew 1 hPa — the painter is now module-scope and `setStep()` calls it itself. Verified live: clicking the chip applies all six overlays + `iso=1` + `flow:colourful`, every chip reports what is on screen, and the URL comes back byte-identical. Tests: `map-presets.bun.test.js` (12 new). **And the showcase itself was repointed**: `🌍 Earth portrait` (the map a first-ever visitor sees) now carries this wind view instead of the old satellite/rain one — owner spec: *"i really like having the wind and also all the other base maps when we first load xyzo.org unless they already have selected something else — use whatever they had for their last view."* That second half was **already** `bootPlan()`'s precedence (⭐ saved default → last used → first visit), so the change was one line: the `portrait` preset's `hash`. **Changing what a first-time reader sees is a one-line change** — `public_html/map-presets.js`, the `portrait` entry and the `COOL_ID` table right below it, both commented as the place to do it. Verified live on a clean browser profile: first load → all ten overlays + `iso=1` + `particles:colourful`; a profile with a stored last-used state → *their* map at *their* zoom, not the showcase. |
| 🌬️ **The wind: four ways to draw it, three ways to colour it, and a speed field** | ✅ shipped (11-03) | Owner ask: *"they don't seem to be correct and are not very visible… maybe we can select the color and type of wind animation? maybe come up with some really revolutionary ideas for showing wind… we also have a base map showing wind speed calculated? that we can control the opacity of as well?"* — followed by *"i like 'colorful' wind can we do that… also the 'flow' is too fast we cant really see the details… its nice if they are all colorful and easier to find."* **The physics was never wrong** — `u` east, `v` north, with the cos-lat correction, checked against the geostrophic balance by `worker/gfs_verify.py` (median angle from geostrophic **23.8°**, 83 % of the flow running towards the low). **What was wrong was the RENDERING, and there were three separate faults in it.** **(1) THE TRAIL WAS TRIMMED BY FRAME COUNT, so a slow wind drew a four-pixel dot.** The particle's speed decides how far it moves per frame, so a fixed 12-frame trail was ~14 px for a 6 m/s wind but **~4 px for a 2 m/s wind** — the slow half of the map was simply not there, and a field of isolated four-pixel dashes does not read as a field. The trail is now trimmed by **LENGTH** (64 px), so every wind is legible and the SPEED is carried by the colour, which is what the ramp is for. **(2) The published ramp starts near-black** (`#0b1020` at 0 m/s), which is invisible on a dark satellite and on a bright one too — so **Colourful** is now the DEFAULT: a full hue sweep that is **bright at BOTH ends** (cyan → blue → violet → magenta → red → orange → yellow), because a colour scheme with a dark end has the same problem as the published ramp. **(3) The colour LUT was EMPTY, so every wind was painted in the same flat grey** whatever the reader chose — `parseRamp()` read `meta.ramp` when it was handed the ACTIVE ramp (an array), so the lookup fell back to grey. That is why the wind looked monochrome no matter what was selected; it is now pinned by a regression test. **Four styles, in the layer's own legend:** **Streamlines** (the trailing streaks), **Flow** (the field as a texture of fibres), **Particles** (moving dots, cheap and honest about being samples), **Arrows** (static arrow glyphs — length carries the speed, head carries the direction: the synoptic reading, and the one that needs no animation at all). **The flow was also rebuilt so its marks TRAVEL**: each is a streaklet that advances along the local wind every frame and leaves a trail, its step proportional to the wind, so a fast wind draws a long fast streak. The first version drew fresh strokes at random positions, which churned — the picture dissolved faster than the eye could follow it (*"too fast — we can't really see the details"*) and the fibres never went anywhere. **Three colour modes:** **Colourful** (default), **By speed** (the published ramp, and the scientific key the legend prints), **Mono** (one bright ink, speed in the alpha — reads over any basemap), plus the site's own palette picker, which now offers **"Published"** first because every value overlay was painting the source's own colours while the picker claimed "Rainbow". **And the wind SPEED field** — its own entry in the dropdown, **"🌬️ Wind speed (GFS)"**, with its own opacity slider (40 % by default: a wash, not a wall). It is the **magnitude of the same u/v pair the animation uses**, so the two share ONE download of `grid.bin` (measured: one fetch for both layers) and the speed wash is literally the ground the streaks lie on. Tests: `public_html/tests/wind-styles.bun.test.js` (26 new). |
| 🔗 **A shared link now reproduces the EXACT map** | ✅ fixed (11-03) | Owner ask: *"why doesn't the url always update whenever the isobars settings are changed so people can always share the exact map they are looking at?"* — with the link `#28.4204,-28.0371,4/density=max/overlay=basins@100,rivers@100,nasa-sat@35,…,isobars@90`. **Three defects, all in the same bookkeeping, and only one of them was the isobar's.** **(1) THE DETAIL STEP WAS NEVER IN THE URL AT ALL.** The 1/2/4/8/16 hPa choice lived only in `localStorage["xyzo.isobarStep"]` — nothing told the hash writer about it, and the grammar had nowhere to put it. A link reproduced the layer but not the setting, so the reader got **their** step, not the sender's. It is now a `/iso=<hPa>` segment, written whenever the isobars are on — **including at the default 4**, because omitting it there would leave the reader's own stored step to decide: a sender on the default would hand a receiver on 1 hPa a link that opened at 1 hPa. **(2) THE URL DESCRIBED THE PREFERENCE, NOT THE MAP.** `overlayOpacityFor()` read the *stored* opacity, and the stored opacity is rolled back at boot (a link is a view, not a settings change) — so the picture said 35 % and the link said 85 %. It now reads the **live layer opacity**, which is what the reader is looking at. **(3) A LINK'S OPACITIES WERE SILENTLY DISCARDED.** The boot snapshot restores the stored opacities and the slider remount that follows re-applies them — a few milliseconds after the link had applied its own — so `nasa-sat@35` came up at 85 %. A link's opacity is now a **view** value: it goes on the layer and the slider, is remembered so the remount cannot clobber it, and does **not** touch the store (the reader's own preference survives). The reader moving a slider ends the override — a choice wins. **Verified live:** the link above now comes back **byte-identical**, every slider shows the link's value (NASA satellite 35 %, soil 40 %, isobars 90 %), the reader's stored preferences are untouched (`xyzo.isobarStep` and `xyzo.overlayOpacity` both still unset), and the round trip flat → globe → flat keeps `iso=1` in all three URLs. **The globe honours it too** — it has no detail control, so 2 hPa is its *default*, but a shared link overrides it; the step is recorded **before** the fetch, because the globe's own hash writer runs on the first `moveend` and would otherwise overwrite the link's `iso=1` with its default (measured: the globe fetched `step=1` and then wrote `iso=2`). Tests: `isobar-step.bun.test.js` (+7), `overlay-opacity.bun.test.js` (+2). |
| ⛅ **The pressure lines are smooth now** | ✅ fixed (11-02) | Owner ask: *"is there anyway to smooth out the pressure isobars — sometimes they have some edges that don't look so good."* **The cause was the ORDER of the contouring steps, not the amount of smoothing.** The pipeline was `round → thin → merge`, and each half of that was wrong in its own way. **(1) The merge ran on ROUNDED pieces.** `merge_isobars()` decides that two pieces are the same isobar by asking whether the next piece's start projects ONTO the previous piece's last segment — an overlap that exists only in the RAW marching-squares geometry, because the contour cut the same corner twice. Chaikin rounding MOVES those ends, the projection test starts failing, and the pieces stop joining. So the merge, which exists to turn thousands of pieces into continuous isobars, was merging almost nothing: **every isobar came out broken into ~4 fragments, and every fragment's end was a hard edge on the map.** **(2) The Douglas-Peucker thinning ran LAST**, and DP replaces a curve with straight chords — so a tolerance above the amplitude the Chaikin rounding leaves behind shaves the rounding straight back off. That is why *"more Chaikin"* on its own changed almost nothing (two extra rounds moved the share of sharp vertices from 2.9 % to 2.8 %, and a LOOSER DP made it **four times worse**). The fix is a reordering, not an extra pass: **merge the raw pieces → round → thin.** Measured on the 2026-11-02 18Z GFS analysis, 2 hPa, whole world: **2,145 lines → 549**, vertices turning more than 40° **2.90 % → 0.68 %**, p95 turn **33.2° → 23.5°**, and the p95 offset from the pressure field **0.195 → 0.170 hPa** — *more* accurate, because a continuous contour is a better contour than four pieces of one. **Measured on the PUBLISHED 1 hPa data over the North Atlantic, before → after:** hard corners (>40°) **2.46 % → 0.48 %** (five times fewer), the worst corner **125° → 104°**, p95 turn **31.6° → 23.3°**, and the lines in that box **336 → 64** — each isobar is now ONE continuous curve. The world-wide response also got **19 % smaller** (626 KB instead of 775 KB raw at `step=1`), because the fragments were carrying redundant vertices. **Four other roads were measured and rejected:** rounding LAST with the DP first (hairpins down 12×, but 4× the vertices AND 4× the lines, because the merge breaks the same way); a stronger field sigma (spikes 50 → 10, but the general hairpins barely moved and σ = 1.5° is a 111 km blur that throws away real structure); a looser DP (four times worse); and more Chaikin on its own (no change). The two couplings the reordering still respects: **the DP tolerance stays below the Chaikin amplitude** (0.01° vs ~0.06°) and **the field is still smoothed before it is contoured**. |
| ⛅ **Pressure lines: a 1 hPa option** | ✅ shipped (11-02) | Owner ask: *"can we update the pressure lines (isobars) to have 1 hPa as well as all the other options?"* The detail switch now offers **1 / 2 / 4 / 8 / 16 hPa**. The control was already the right shape — one dataset, five densities — but the finest **published** set was 2 hPa, so a 1 hPa chip would have had nothing to draw. **The worker now contours at 1 hPa** (`ISO_INTERVAL_HPA = 1`), which is the only way to get it: a 1 hPa contour cannot be derived from a 2 hPa one. The design still holds — the contour of a level does not depend on the interval used to enumerate the levels, so **level 1000 at 1 hPa is vertex-for-vertex identical to level 1000 at 4 hPa**, and the classic 4 hPa chart is a thinning of the new set, not a second dataset. Cost: GFS ~2,000 → **~1,100 lines** (46 → 92 levels — the line count went DOWN because the merge now works, see the row above), the world-wide response ~389 → **~626 KB raw (236 KB gzipped)** at `step=1`, and the 6-hourly worker's contouring ~24 s → ~45 s on the 0.25° grid (ECMWF's 0.1° grid is the slow one, ~2 → ~4 min). **The check that made it safe**: a finer interval could have meant a noisier chart, so the fragment share was MEASURED rather than assumed — the share of lines under 20° is **76.6 % at 2 hPa and 76.9 % at 1 hPa** (under 5°: 58.8 % vs 59.1 %). The noise lives in the FIELD, and the Gaussian smoothing takes it out before the contour is cut, so 1 hPa is the same chart with more lines in it. **Also fixed**: the step chips carried the container class `.soil-prop-switch` but not the button class `soil-prop-btn`, so they rendered as bare default `<button>`s in a dropdown that is otherwise all chips — with five of them that read as a row of grey blocks. Tests: `isobar-step.bun.test.js` (the superset and the noise claims are now pinned), `worker/tests/test_isobars.py` (48 pass, incl. a **vertex-for-vertex** superset test), `api/tests/weather-isobars.test.ts` (every offered step accepted; the 1 hPa set is a superset of the 4 hPa one). |
| 📏 **The `app.js` size ceiling is gone** | ✅ removed (11-01) | Owner: *"we shouldn't have a limit for size of app.js — why, for speed reasons?"* **It was not for speed, and it measured the wrong thing**: `app.js` ships as **~245 KB gzipped** (850,000 is raw source, which gzip crushes 3.5×), **all 62 scripts on the page are `defer`** so it never blocks rendering, and it is served **`immutable` for a year** — a one-time first-visit cost, not render time. Added 2026-10-29 in `fbb3ed5` as a *"runaway-growth ceiling"* whose rationale lived **only in the test comment** — the commit message never mentions it. By 11-01 it was the binding constraint on every frontend change (**six assertions across four files**) and had reshaped real work: the population overlay went into a **`generic-layers.js` registry** instead of being named inline (README recorded *"8 bytes"* of margin as the reason), state-abbrev search moved **3.4 KB** into `city-engine.js`, the layers-tap fix **deleted six uncalled functions** to get back under, and the Cool-maps `keepView` fix had to relocate its rationale into a test file to save 46 bytes. **All six assertions + the AGENTS.md rule removed**; each site now carries a comment pointing at `code-splitting.bun.test.js`, which records the full reasoning so nobody re-adds a ceiling by pattern-matching an old one. **Kept: the `loadChunk()` rule** — code not needed at boot stays out of `app.js`. That governs *where* code lives, not how many bytes it takes. |
| 🧊 **Cool-maps presets now keep your view** | ✅ fixed (11-01) | Owner ask: *"when you select various cool maps can you keep the perspective and zoom level and just update the selections… often people want to change the settings but keep the zoom and perspective."* It was a trap **because presets are stored as FULL app hashes** — `#lat,lng,zoom/density=…/overlay=slug@pct,…` — deliberately, so a preset, a pasted link and a saved style all run through the **same parse/apply path** and can never diverge. `presetState()` therefore hands back `lat/lng/zoom`, and `applyMapState()` calls `map.setView()` whenever all three are finite — so a click on a chip **teleported the camera to that preset's own hard-coded centre and zoom**. The fix is the `keepView` flag **Clear already passed for exactly this reason** (its own comment: *"must not fling the user back to the world"*), now also passed from the chip handler. **What it does NOT replace:** the earlier *"every preset is a GLOBAL view, zoom ≤ 3"* rule only narrowed **where** a chip flung you — it never stopped the flinging. **`Reset` deliberately does not pass it** — returning to the world view is its entire job — and the new test asserts **both** directions (chip keeps the view, Reset does not), mutation-checked: drop `keepView` and it fails. `app.js` 849,984 / 850,000 (see Q0); token via `bump_frontend.sh`, matching the previous `app.js` fix. |
| 📊 **Source rankings revived — attribution now derived server-side** | ✅ fixed (11-01) | `news_interactions.source_id` was **NULL on every one of 9,840 interactions in 30 days** (last non-NULL: 09-04), so `calculate_source_rankings()` upserted nothing and `news_source_rankings` held **214 rows for 4,213 sources, frozen at 10-04** — while `aggregates_refreshed` said `true`. The client *could not* fix it: `/api/pins/map` returned no `source_id` and no `article_id`, and a map pin is a **cluster** of articles so there is no single honest source to send. Fixed entirely server-side: the map now returns `article_id` (measured — **200/200 sampled pin ids are `news_articles.id`, 0/200 are `pins.id`**), and both analytics endpoints resolve the article from an explicit `article_id` **or from the id sent as `pin_id`** (guarded by `NOT EXISTS (… pins)` so a real community pin is never misread), then **look up** `source_id` from that article — so a caller that lies about `source_id` cannot inject attribution it does not own. No client change was needed, which mattered: `analytics.js` is served `immutable` for a year with **no `?v=` token at all**, so a client-side fix would never have reached a cached browser. 7 tests, `api/tests/analytics-source-attribution.test.ts`. |
| ⏰ **Stopping a job silently disarmed its own schedule** | ✅ fixed (11-01) | Seven `xyzo-*.timer` units declared **`Requires=` their own service**, so `systemctl stop <job>` stopped the **timer** too — found while recovering the wedged fetcher (the timer had to be re-armed by hand). The trigger is `Unit=`, not `Requires=`; five timers had it explicitly and two resolve correctly to systemd's default, and nothing depended on the side effect (`emergency-stop.sh` only echoes those commands). Removed from all seven + `daemon-reload`, then **verified by experiment**: the timer still fired at **exactly 14:40:00** with `TriggeredBy: ● xyzo-nn-infer.timer`, and stopping that running service printed *"it can still be activated by: xyzo-nn-infer.timer"* with the timer staying **`active`, armed for 14:45**. All seven remain `active`/`enabled`. |
| 🧵 **One slow row threw away the whole extraction batch** | ✅ fixed (11-01) | `extract.py:_batch_update_articles` ran the **entire batch in one transaction** (no commit in the loop at all) — so **one** `QueryCanceled` rolled back every row (what the 10-29 nightly lost) and the transaction held `news_articles` row locks for the whole batch, starving *other* writers into tripping `statement_timeout` and blocking autovacuum. **The same defect `learn.py` fixed on 2026-09-26**, this call site simply missed. The diagnosis mattered more than the fix: a row is bounded work (~**1.1 s** — `trg_detect_cities` scans **8,264 `world_cities`** with four `LIKE '%…%'` and no usable index; despite its "non-blocking" comment it runs a synchronous `PERFORM`), so 60 s was never about a slow query — it was about *waiting* on a lock or a swapping box, and "just raise the timeout" would have buried the transaction bug underneath. Now: **commit per row** + `SET LOCAL 300s` per statement — **`SET LOCAL`, not `SET`+`RESET`**, because after a failed row the transaction is ABORTED and a `RESET` from a `finally` raises `InFailedSqlTransaction`, masking the real error and dirtying the pooled connection. 4 tests, `worker/tests/test_extract_batch.py`. |
| 🖱️ **A tap on a layers row did nothing** | ✅ fixed (11-01) | Reported as *"you click on city names once then turn it off and the names still show up"*. Traced on an iPhone 14 Pro with a real touchscreen: `touchend INPUT…selector scroll=1173` → `mousedown BUTTON.leaflet-preset-chip scroll=0`. **Three defects, all inside Leaflet's own `_expandSafely`, which fires from `mouseenter` — and on touch Chrome synthesises that mouseenter from the SAME gesture as the tap**, so it lands before the click. **(1) Height**: it rewrites the list's height with Leaflet's hard-coded 50 px reserve (`660 − 10 − 50 = 600`), overwriting the measured cap — and **rewriting `height` on a scroll container RESETS `scrollTop` to 0**, so the row you had just scrolled to vanished and the synthesised click landed on a Cool-maps preset chip, which got *applied* instead. `capLayersListHeight()` no longer clears `height` to re-measure (**`scrollHeight` is the CONTENT height whether or not the box has one**, so the clear bought nothing) and skips the write when the value is unchanged; `layersControl.expand` is wrapped to re-apply the cap and restore the offset. **(2) Click**: `_expandSafely` registers `L.DomEvent.preventDefault` on the whole list for one tick, cancelling the click that toggles the box. **(3) Layer**: it also sets `_preventClick`, and `_onInputClick` is gated on `if (!this._preventClick)` — so even with the click delivered the layer was never added. **All three were needed**: fixing only (1) left the click swallowed, and (1)+(2) ticked the box without activating the layer. **Also**: the panel had **no `max-width`** and is right-anchored, so it sizes to its widest row — which grew when the legibility sweep raised the base font: on a 393 px phone it went **383 px → 418 px at x = −35**, putting the **checkbox column off-screen** (`elementFromPoint` at the City names box returned `null`), which reads exactly like "the layer ignores the checkbox". Verified: a full **ON→OFF→ON→OFF** cycle with real taps returns `[True, False, True, False]`; `validate-api.sh` exit 0; **1105 pass / 0 fail**. Tests: **6** in `layers-panel-tap.bun.test.js`, each **mutation-checked**. app.js **849,917 / 850,000 — 83 bytes of headroom** (six uncalled helpers and four dead consts removed to make room; `MODE_BUTTONS` kept because a test pins it, `doShowAll` kept because `index.html` calls it). |
| 📴 **Offline: the map now survives dead links** | ✅ shipped (11-01) | Owner ask: *"how ready are we for 100 % offline if various links/connections go bad."* Measured first (`scripts/offline_audit.py`, three phases in ONE persistent profile — `chromium.launch()` hands out a fresh profile per call, so phases would otherwise each measure a cold browser): **WAN down** = page booted and the API answered **200**, but **0 of 72 basemap tiles** loaded and **nothing said so**; **fully offline** = the navigation itself failed (`net::ERR_FAILED`) because nothing had ever been cached. New **`public_html/sw.js`**: the shell is precached by **parsing `/index.html`** for its refs (a hand-maintained asset list drifts the moment a layer ships), `/data/*` cache-first, `/api/*` network-first with a stale fallback, and a **bounded 400-entry** tile cache over the 9 hosts that actually serve imagery (unbounded it would eat the quota and the browser would evict the shell too — the one thing that must never go). New **`offline.js`** registers it and carries **two honest notices**. **Four defects, all found by running it rather than reading it:** **(1) THE WORKER NEVER FINISHED INSTALLING.** The help page carries plain `<a href="/api/pins/map?bbox=…">` links and a `<form action="/search/results">`; the ref regex strips the query string, so install asked for `/api/pins/map` **with no bbox** — which does not answer, it **hangs** — and one pending fetch inside `Promise.all` meant the install event never settled: measured `active=false installing=true` at 9 s **and still at 20 s**, so the worker never activated and phase 2 had nothing to serve. Now dynamic endpoints are skipped and **every precache fetch is bounded to 8 s** (a partially warm shell beats no shell). **(2) A REGRESSION I INTRODUCED, caught by an A/B:** `networkFirst` did `await cache.put(...)` **before** returning, and `cache.put` waits for the response **body** to finish — an SSE body finishes only when the server closes it, so `/api/feed/live/stream` never reached the page. Same page, both runs worker-controlled: **buggy → `open=false snapshot=false error=false`** (hung 8 s), **fixed → `open=true snapshot=true`**. Streams are now never cached. (The first version of that test listened on `onmessage` and reported both variants identical — the server emits a **named** `event: snapshot`, so an onmessage-only test is blind.) **(3)** The tile notice was shown and then **immediately hidden**: window `load` calls `sync()` → `show(true)` → `hide()`; the log said "shown" while the probe said false. **(4)** Its recovery rule accepted *any* 6 successes, so **24 successes among 48 failures** cleared a notice that was still true — it now needs successes to **dominate**. Also **`/etc/caddy/Caddyfile`**: `sw.js` fell under the `*.js` **immutable-year** rule, which would pin every installed worker to the copy it first saw (updates only when the browser's 24 h check bypassed the cache) — it now serves `no-cache, must-revalidate`. **Measured after:** online **72/72 tiles**; WAN-down **boots, 24/72 tiles drawn, honest "Map imagery isn't loading" notice**; fully offline **boots from the cached shell** (`navigator.onLine` false, "You're offline" banner, `/api/health` 200 from cache, pins/rivers/soil/cropland all painted). **First visit while offline still cannot work** — see Known Issues. Tests: `offline-layer.bun.test.js` (**21**). |
| 🌐 **World view showed ZERO stories; every SSE snapshot failed** | ✅ fixed (11-01) | Two silent API defects found while auditing the offline path, both of which parse cleanly — which is why `validate-api.sh` never caught either. **(1) `parseSince` was nested INSIDE the `/feed/live` handler** (line 110 opens it), so that route's own call resolved but `/feed/live/stream` — a *different* scope — threw `ReferenceError: parseSince is not defined` on **every** connection, and the catch sent clients `snapshot_failed`: the live feed was empty for everyone, and the existing test still passed because it asserted only that *a* snapshot **arrives** (the failure path sends one too). It is now module scope, and `sse-feed.test.ts` asserts `parsed.error` is **undefined** — mutation-checked: reverting `feed.ts` fails with `Received: "snapshot_failed"`. **(2) `news_locations.geom` is `geography`, and nine `&& ST_MakeEnvelope(...)` sites did not cast it.** A geography envelope is evaluated **geodesically**, and one that wide is degenerate — it does not error, it silently stops overlapping: measured against production, **180° → 31,721 rows, 200° → 9,753, 270° → 3,260, 358° → 6**, against **41,797 with `::geometry`**. So the failure is invisible at city zoom (where every manual test happens) and bites at **world view**, where `feed.ts`'s 7 sites emptied "Hot & Latest" and `insights.ts`'s 2 emptied the region queries — while `pins/map` had **always** cast (`location::geometry`), so the pins looked perfectly healthy beside a dead feed. Two codepaths, two conventions, one of them wrong. All nine now cast (plus `weather_isobars`, an identity cast, so the rule needs **no exception list**). Verified live after restart: **world view 0 → 10 stories**, Europe still 100, SSE returns real items, **0** snapshot errors in the journal; `hours=24/168/none` all still answered. New **`api/tests/bbox-cast.test.ts`** counts `&& ST_MakeEnvelope` against `::geometry && ST_MakeEnvelope` across `api/src` (a count, not an operand parse, so it still fires if someone puts the operand on the previous line) and pins the schema premise — mutation-checked: dropping one cast fails with `routes/feed.ts:269`. Tests: **22 pass** across `bbox-cast` + `sse-feed` + `feed-bbox`. |
| 🏞️ **River labels: no more "benue benue"** | ✅ fixed (11-01) | Reported as *"odd names show up above the map — city name like benue benue over Africa or san francisco down in south America"*. They were **river** labels (city names were OFF in that URL — no `city-names` overlay), and the layer labelled **one label per GeoJSON FEATURE** — but Natural Earth **splits a single river into several features**, so the Benue was drawn twice, **43 px apart**. Measured live with Playwright at the reporter's URL: **11 names doubled** (Benue, São Francisco, Paraná, Tocantins, Ob, Yenisey, Salween, Vaal, Shishged, Little Yenisei, Paranaíba) **and 20 of the 40 label slots spent on anchors off-screen** (the loop walked the file and broke at 40, so a visible river later in the file never got labelled). Three rules now, in a pure `chooseLabels()` exported as `RiverLayer._chooseLabels`: **one candidate per NAME**, kept on the feature with the most vertices (the longest stem, so the callout sits on the main river — the label for "San Francisco" is the *São Francisco River* in Brazil, which is correct, just no longer doubled); **on-screen only** (`bounds.pad(0.1)`, so a river entering the view is already labelled); and a **70 px screen-space gap** — Paraná and Paranaíba *join*, so their anchors sat 42 px apart and the words collided; candidates are ranked scalerank-asc so the river that loses a slot is the less important one. Placement is now viewport-dependent, so labels **re-place on `moveend`** (150 ms), not just `zoomend`. Live after: **23 labels, 23 distinct names, 0 doubled, 0 far off-screen**, and a scripted half-viewport pan re-places them the same way (18 labels, 0 dups, 0 errors). New tool `scripts/river_labels_check.py` reads the rendered `.river-label` DOM (not the layer's bookkeeping) and fails on a doubled name; 4 new tests drive `_chooseLabels` directly. Contract in `overlay-contracts.bun.test.js` widened (the cap is now the used `MAX_LABELS`, plus `byName` dedup). Full suite **1076 pass / 0 fail**. |
| 🎨 **Selectable colour palettes on the data overlays** | ✅ shipped (11-01) | Answering "a way for us to select different colours for all overlays" — the control was not there to be found. New `ramp-styles.js` (7 palettes: **rainbow, viridis, turbo, inferno, warm, cool, greyscale**) + `overlay-palette.js`, injected into every overlay row **by `overlay-opacity.js`**, which already walks those rows — so `app.js` never mentions either and stays **8 bytes under** its ceiling. **Capability-driven, not a filename list**: a picker mounts only where a layer exposes `setPalette` (value overlays) or `setFilter` (picture overlays), which is how **Köppen, Soil, Cropland, Land Cover, Phytoplankton, Basins and Languages are excluded automatically** — their colours *are* their meaning, and recolouring "tropical rainforest" to violet turns a classification into decoration. `recolour()` **keeps every stop's `c` and only rewrites `rgb`** (positions are what the probe reads and the legend prints), copies sibling fields through, and never mutates the published ramp. **Three bugs found by running it rather than reading it:** (1) `ramp-styles.js` was never added to `index.html`, so `window.RampStyles` was undefined and the picker **returned silently — no controls anywhere, no error**; (2) `setPalette` was an object *method* inside the export, but the arrow on the tile layer calls it by name → `ReferenceError`, swallowed by `applyTo`'s catch, so nothing was written; (3) the **legend bar kept the published gradient** after a change, promising one scheme while the tiles painted another. Verified in a browser: temperature row → `Rainbow` dropdown, population → `As published`, picking changes the **screenshot hash** (the MAP repaints, not just the control), the legend gradient changes, and `getPalette()` is still `rainbow` after a reload. Population is served **pre-coloured by FAO**, so it takes CSS **filters** (`hue-rotate`/`saturate`/`grayscale`/`sepia`) — labelled "Hue shift", not "Rainbow", because a value-mapped rainbow needs the raw grid. Tests: `ramp-palette.bun.test.js` (24). |
| 🔁 **2D ↔ 3D panel parity + shared-link test** | ✅ fixed (11-01) | Asked to make the two views offer the same layers and to pin it. **Measured both panels live from a clean profile** (localStorage cleared *before* any app JS, so the first-visit showcase preset could not pollute the defaults): **12 of the 15 shared overlays already agreed.** Five did not. **(1) Labels renamed in one view only** — the globe said "🛰️ NASA Satellite" / "🌧️ NASA Rain Rate" where the flat map says "… (True Color)" / "… (IMERG)", so a user comparing panels, or a panel against a shared link, saw two different layers. The globe now uses the flat map's names (it is the reference view and it is where the names were chosen). **(2) Default opacity disagreed on three** — temperature **0.9 → 0.55**, magnetic **0.9 → 0.80**, lightning **0.9 → 0.85**: same overlay, same slider, visibly different result. Each now reads its module's own default. Verified live: **all 15 at their expected value**. **New `panel-parity.bun.test.js` (13 tests)** asserts: every globe overlay exists on the flat map under an **identical label**; every flat overlay absent from the globe is listed in **`NOT_PORTED` with a reason** (so an overlay added to the flat map and forgotten fails the build until someone decides); nothing in `NOT_PORTED` has since been ported **and** nothing in it is ghost — both directions, so the allowlist cannot rot; shared overlays agree on default opacity; every shared hash key round-trips; and **the owner's example link survives both ways**, `#…/overlay=soil@40,isobars@100` ↔ `soil-soilgrids@40,isobars@100`. **Mutation-checked**: renaming a globe label fails 2 tests, drifting one opacity fails 1. The **13 unported overlays are now an explicit contract with their reasons** (wind is a screen-space animation, contacts are WMS, the field/transport/salinity/ocean family are wrapping `L.GridLayer`s …) rather than a gap nobody notices. Tests: 13 new, **1047 pass / 0 fail** (twice — a first run raced another session mid-write). |
| 👁️ **Nothing detected a unit that exited non-zero** | ✅ fixed (11-01) | The watchdog's two checks were both blind to the actual failure: `check_service_stuck()` inspects services that are **RUNNING** (a broken oneshot has already exited → reports "not running" → passes) and `check_all_timers()` inspects the **timer**, which fires perfectly and then waits for its next slot. **No script in the repo ran `systemctl --failed` at all** — which is how `xyzo-graph-features` could sit red for a month and `xyzo-nightly` fail every night with zero alerting. New `check_failed_units()` reports `xyzo-*` units in `failed` state and exits 1; `recover_failed()` re-runs only the two **idempotent, short** jobs (`graph-features` ~6 min, `trending` ~30 min) and **deliberately never `nightly`** (a 4-hour off-schedule AI cycle) — using `start --no-block`, because a blocking `systemctl start` on a oneshot would pile up overlapping runs under the `*/2` cron. `xyzo-graph-features.timer`, `xyzo-nightly.timer` and `xyzo-trending.timer` joined `CRITICAL_TIMERS`. **It caught `xyzo-trending.service` failed within minutes of being added** (its 4th step, `compute_pmi`) — a unit nobody had noticed either. 14 tests in `worker/tests/test_timer_watchdog.py`, one of which caught a real gap I shipped first: `trending` was auto-recoverable but its timer wasn't watched. |
| 🕐 **Two jobs died at the 60 s `statement_timeout` — every run** | ✅ fixed (11-01) | `worker/db.py:85` sets `-c statement_timeout=60000` pool-wide. Two statements measured **well past it**: `update_source_keywords`'s `SELECT` (3 M rows of JSONB over the 90-day window) = **94 s**, and `compute_event_graph_features` = **105 s** — so both raised `QueryCanceled` *every single run*. Consequences: `news_event_graph_features` was **frozen at 2026-10-02** (a month of stale graph scores feeding `/api/feed/*` at feed.ts:251/351/513/651), and `learn.run_all()` died at **step 6 of 7**, silently skipping `location_rankings` (stale 10-26) *and* the whole `calculate_source_rankings()` / `calculate_geo_interest(24)` / `REFRESH source_leaderboard` block (`news_source_rankings` was stale from **10-04**). Fixed with the pattern `compute_tfidf.py` already uses: `SET statement_timeout = '600s'` scoped to the one statement, `RESET` in a `finally`. Verified: `refresh_graph_features()` → 4,535 events in 338 s and **`systemctl start xyzo-graph-features` → `status=0/SUCCESS`**; `update_source_keywords()` → 326 s, 2,695 sources / 132,498 keywords; **full `run_all()` → 386 s with `location_rankings: ok` and `aggregates_refreshed: true`** — both of which had been skipped for a month. |
| 🕳️ **The nightly's other failure: 50 articles with `NULL source_id`** | ✅ fixed (11-01) | `learn.py:1189` raised `NotNullViolation` because `news_source_keywords.source_id` is NOT NULL. Root cause, traced end to end: `news_articles.source_id` is **`ON DELETE SET NULL`** (Tier 1.4 — deliberate, so deleting a source preserves its articles), and on **10-29 14:44:34** the wildlife import created **102 sources with consecutive ids 17937–18038 — only 98 survive; 4 were deleted** (18017, 18019, 18032, 18034). Deleting a duplicate feed row orphans that copy's articles, and `ON CONFLICT (url, source_id) DO NOTHING` **cannot stop the duplicate**: NULL never conflicts with NULL in Postgres — which is also why 20 of the 50 are duplicate URLs *inside the batch*. The four survivors (Snow Leopard Trust, Hakai Magazine, WOAH/OIE, Kazakhstan Snow Leopard) are why all 50 have a sourced twin. Fixed with `AND source_id IS NOT NULL` in the query **plus a `sid is None` guard in the aggregation loop**, so removing either later cannot reopen it. **Only three batches have ever existed** (09-13: 11, 09-14: 10, 10-29: 50) — this is rare, not ongoing. The 50 rows are deliberately left alone: see Q4. |
| 🛑 **Wedged fetcher held a 6.2 h open transaction** | ✅ fixed (11-01) | `xyzo-fetcher` (`PID 642985`) was **7 h 47 m** into a ~1 h 45 m job, stuck in **D state** at **4.6 GB RSS**, holding an **`idle in transaction` for 6.2 h** on that same `learn.py` query — the oldest transaction on the box, while `news_articles` sat un-vacuumed since 10-29 with 533 k dead tuples. It had blown past `MemoryHigh=3.0G` (at 4.4 G), so systemd was throttling it, which is likely *why* it stalled. `systemctl stop` released it: **idle-in-transaction → 0**, used memory 22 G → 17 G. Two findings worth keeping: `systemctl status <PID>` maps a PID to its unit, and **`kill` failed with `EPERM`** (the process runs as root) — the route that works is `sudo -n systemctl stop`, because the sudoers file grants NOPASSWD on `systemctl *`. |
| 🧭 **Magnetic WMM: the wash breathes, the lines glow** | ✅ shipped (11-01) | Owner ask: *"make it look way cooler, more transparent and more colourful."* Two root causes. **(1) THE WASH WAS AN OPAQUE SHEET.** `buildLut()` published RGB only and the bake wrote `alpha = 255` everywhere — so the ΔD zero plateau, which covers **~52 % of the globe**, painted a flat cyan sheet straight over the satellite basemap. Each field now publishes its own **`{t, a}` alpha table** in `meta.fields[k].alpha` (the contract the LIGHTNING meta has always used): **nearly clear at zero (~40/255), solid at the wings (~240/255)**. The diverging tables derive their transparent band from the **same `plateau` the colour uses**, so the see-through core and the flat cyan band are the same width; the sequential ones (F, H) ghost the weak field and solidify the strong, so the **South Atlantic Anomaly reads as a hole** — which is what it is. Measured on the real D field: mean alpha **255 → 116**, **37 % of the globe now nearly clear**. **`check_alpha_tables()` gates it at build** — a missing, non-ascending or opaque-core table aborts the publish, because a client that receives none falls back to 255 and the regression is invisible in review. The legend bar renders `rgba()` stops too: an opaque bar promises a sheet the map does not draw. **(2) THE "HERO" LINES WERE INK-BLACK.** AGENTS.md calls the contours the hero of this overlay and they shipped `#111827` — invisible on the dark satellite basemap the site opens on. `styleFor()` now colours each line from the **field's own ramp at the line's own level**, lifted toward white (35 % index/minor, 20 % specials) so a line at level L still reads **on its own wash band** (an unlifted line would vanish into a wash of the same hue). The agonic / aclinic / no-change landmarks sit at level 0 and land on the cyan glow automatically. The **3D globe** does both too — RGBA bake from the same table, and a **data-driven `["interpolate", ["linear"], ["get","level"], …]`** line colour with `level == 0` pinned to cyan, applied under the `gen` guard so a failed fetch for a stale field cannot repaint the lines. Gates: worker **89 pass** (2 new alpha tests, incl. a mutation check that the gate can fail), frontend **1033 pass / 0 fail**. |
| 🌊 **3D globe: basins were a solid cyan sheet** | ✅ fixed (11-01) | Reported with two URLs to compare. The globe's generic fill/line builder wrote the **slider value straight over the overlay's own `paint` opacity**, so a deliberately low base was discarded — the flat map has always **multiplied** the two (`basin-layer`: `fillOpacity: 0.16 * state.opacity`, `river-layer`: `opacity: 0.9 * state.opacity`). **Hydrological Basins** is the one that showed, because its base is `0.16` and its slider default is `0.7`. Measured at runtime on the shipped build: **`basins@100` applied `fill-opacity: 1.0` — fully opaque** — and the entire globe became a flat cyan sheet with the satellite, Köppen, soil, cropland and every other layer underneath simply **buried**; `basins@35` applied `0.35`, still **2.2×** the intended wash. You could see the watershed outlines and nothing else — the exact inverse of the flat map, where basins are a hairline over terrain you can still read. `baseOpacity(o, prop)` now reads the base (absent or out-of-range → 1) and **both the builder and `applyOpacity()` compute the same product** — keeping the two paths identical is what stops a freshly-loaded layer and a slider-dragged one disagreeing. **SUPERSEDED 2026-11-09, and the correction matters:** the last clause read *"The fill's `-line` sibling uses the **fill's** base, so the outline dims with the wash instead of glowing out of a faint fill"* — which was true, and was the wrong decision. The fill's base is 0.16 and the flat map's hairline is 0.85, so on a 0.8 px stroke that reasoning shipped outlines at a sixth of their intended strength and the owner could not see them at all (*"i dont see the black outlines"*). The outline now multiplies **its own** 0.85 base; it still dims with the slider, it just no longer borrows the wash's number. See the 11-09 row above for the measurements. **`rivers` was the trap that hid it**: its base (`0.85`) equalled its slider default, so the bug was invisible there while it buried the basins — now `1.0`, rendering at exactly the strength it always shipped at. After: `basins@100` → **0.16 / 0.16**, and your URL reads as a real Earth again. Tests: **8** in `globe-overlay-opacity.bun.test.js` (with a **mutation check** — re-introduce `"fill-opacity": startOpacity` and it fails), suite **1033 pass / 0 fail**. |
| 🛣️ **Preset: "Street mode" chip in ✨ Cool maps** | ✅ shipped (11-01) | The owner's own favourite view is now a one-click preset chip in the layers dropdown (`🛣️ Street mode`, second chip after `🌍 Earth portrait`): **OpenStreetMap street base + ETOPO relief 45 % + SoilGrids 30 % + ESA cropland 45 % + ESA land cover 20 % + a 5 % Köppen wash, pin density Max** — the "what the land is made of" skin over a street map. Stored verbatim as the owner's shared hash `#30.2211,-22.3242,3/density=max/base=street/overlay=etopo@45,soil-soilgrids@30,cropland-esa@45,land-cover-esa@20,koppen@5` in `map-presets.js`'s `PRESETS` — the **first preset with a non-satellite base layer** (`base=street`), which exercises the `base=` half of `parseHash()`/`applyMapState()` that the other six never touched. All five overlay slugs are explicit `LAYER_SLUGS` keys, so the preset-slug test passes; pinned verbatim by a new test in `map-presets.bun.test.js` (29 pass). Per-file cache token bumped to `202611010722` via `bump_asset_token.sh` (not `bump_frontend.sh` — map-presets.js is deliberately outside its ASSETS list). Tests: 29/29 in the preset suite. |
| 👥 **Preset: "Where people live" (population)** | ✅ shipped (11-01) | Owner ask: their pasted population-map URL as a preset chip. `👥 Where people live` (third chip) stores their hash **verbatim** — `#14.0087,14.9414,3/density=max/base=light/overlay=soil-soilgrids@45,population-density-worldpop-1-km@100,isobars@100,cropland-esa@45,koppen@30,basins@100,rivers@100,land-cover-esa@10,etopo@30` — **nine overlays on the LIGHT base**, the heaviest preset there is, hence `tier: "high"` so a thin phone never auto-loads it. **Its slug is deliberately NOT an explicit `LAYER_SLUGS` key**: `app.js` sits at **849,992 B against the 850,000 runaway ceiling** (8 bytes), and pinning a key there would fail CI for a reason unrelated to the change — the same pressure that produced `generic-layers.js`, which is how the population overlay registers at all. `population-density-worldpop-1-km` instead resolves through `getLayerSlug()`'s **exact** comparison against the module's `LAYER_NAME` (`🧍 Population density (WorldPop, 1 km)`) — deterministic, not the substring scan. The preset-slug test was therefore widened from "explicit key only" to **"resolves deterministically by either route"**, with a guard asserting the two routes are genuinely different doors (`derived.has("population-density-worldpop-1-km")`), so it still cannot pass on substring luck. Pinned verbatim by a new test (30 pass). Token `202611011623` via `bump_asset_token.sh`. |
| ⛈️ **Preset: "Storm watch" upgraded to the full weather view** | ✅ shipped (11-01) | Owner's pasted weather URL, stored verbatim as the `⛈️ Storm watch` chip: **eleven overlays** — `temperature@30`, `wind-gfs@100`, `lightning@60`, `isobars@90`, `nasa-rain@100`, `nasa-sat@100`, `koppen@35`, `moisture-transport-ivt@45`, `rivers@100`, `basins@100`, `convective-instability-cape@45` — replacing the original four-layer storm chip (`#28,-32,4/…isobars@90,temperature@55,wind@100,lightning@85,cape@70`). **Two of the slugs exposed a real gap in the preset-slug test**: `moisture-transport-ivt` and `convective-instability-cape` reach their `LAYER_NAME` through the **field-layer factory's `layerName:` argument** (cape-layer.js / ivt-layer.js pass it as an option), not a direct `LAYER_NAME:` declaration — so the test's derived-slug scan, which matched only `LAYER_NAME:`, could not see them, while the browser resolved them fine via `getLayerSlug()`. The scan now matches **both spellings**, and a comment on the preset records why. This is exactly the failure mode the explicit-key rule exists to prevent, caught here by a test that had been narrowed one spelling too far. Pinned verbatim by a new test (31 pass in the preset suite). Token `202611011931` via `bump_asset_token.sh`. |
| 🪨 **Preset: "Geological" (owner's view, lightened)** | ✅ shipped (11-01) | Owner's geological URL as a ninth chip, `🪨 Geological`, placed right after `🧭 Hidden forces` since the two are siblings. Their first draft was `geology-macrostrat@75` at **zoom 3 over the Sahara**; "we might need to go slightly lighter" → **`geology-macrostrat@40` at zoom 7 over the Congo basin** (`#0.1923,15.5896,7/overlay=magnetic@100,etopo@55,geology-macrostrat@40,basins@80,rivers@100,soil-soilgrids@100`), where relief and soil carry the picture and the bedrock reads as a tint rather than a wash. **Four of its six overlays overlap 🧭 Hidden forces** — the two differences that earn it a separate chip are `soil-soilgrids@100` and the far lighter geology at a detail-first zoom. All six slugs are **explicit `LAYER_SLUGS` keys**, so it needs no derived-route exemption. No `density=` segment, so applying it leaves pin density untouched (asserted). Pinned verbatim by a new test (32 pass in the preset suite). Token `202611012040` via `bump_asset_token.sh`. |
| 🌍 **Cool maps are GLOBAL views — never zoomed in** | ✅ shipped (11-01) | Owner rule: *"we don't want the geological maps or any of the cool maps to zoom in, we just want global views."* Every chip now opens at **zoom ≤ 3** — near-global, continents readable, the world filling the screen. Four presets moved: **`🪨 Geological` 7 → 3** (it had shipped zoomed into one Congo basin, hiding the rest of the planet), and **`🌍 Earth portrait`, `🧭 Hidden forces`, `🌌 Night lights` 4 → 3**. The other five were already at 3. **A guard test now pins the rule** (`every Cool maps preset is a GLOBAL view`): it walks every preset and fails on any zoom above 3, so a future preset cannot quietly ship zoomed in — and the bound is `≤ 3` rather than `== 3`, so a *farther*-out preset (zoom 2, the whole globe) stays legal while a closer one never passes. The portrait showcase test moved with the rule. Token `202611012103` via `bump_asset_token.sh`. |
| 🧍 **Population density overlay (WorldPop, 1 km)** | ✅ shipped (11-01) | New layers-dropdown entry **"🧍 Population density (WorldPop, 1 km)"** with the standard opacity slider, at **pane 349** and **`minZoom: 6`** so the 1 km detail appears only in detailed zoom modes (your ask) — verified: **z4 fetched 0 tiles, z9 rendered**. **Source is a hotlinked FAO WMTS, not a baked pyramid**: a faithful 1 km z12+ pyramid would be *millions* of tiles (cropland, 10 m but only z9, is already 92,066 tiles / 605 MB), while a WMTS GetTile **is** an XYZ template Leaflet reads directly — zero stored bytes, same trade NASA GIBS and Macrostrat already made. **The published catalogue URL is wrong in two ways**, both found by asking the service instead of trusting it: `tilematrixset=EPSG:900913` → HTTP 400 (the service's real name is **`WebMercatorQuad`**), and the omitted **`style`** parameter → `Missing 'GetTile' parameters: {'style'}`. With both fixed: **200 across z0–z15**, and in-browser **35/35 tiles, 0 failed**. **CC BY 4.0** (attribution-only, row added to `docs/DATA_LICENSES.md`, enforced by `data-licences.bun.test.js`), rendering bottom-right as *"Population density: WorldPop, University of Southampton — CC BY 4.0"*. **Two defects found by my own browser check**: (1) `OverlayOpacity` calls `setOpacity` on the *TileLayer* in `WEATHER_OVERLAYS`, not on `window.PopulationLayer` — the layer faded while `getOpacity()` kept returning 1, i.e. two sources of truth; fixed by wrapping the TileLayer's `setOpacity`. (2) the module sits in a **registry file (`generic-layers.js`)** rather than being named inline in `app.js`, because `app.js` was **849,990 / 850,000 bytes** — naming it twice inline (+36) would have blown a ceiling whose own comment says *extract, don't raise*. The swap costs **two bytes** (margin now 8) and makes every future overlay of this shape free. Tiles are pre-coloured by FAO, so this overlay deliberately exposes **no `sampleAt`/export surface** — we hold a picture, not values. Tests: `population-layer.bun.test.js` (15). |
| 🏷️ **`app.js` shipped behind a stale `?v=` token** | ✅ fixed (10-31) | `bump_frontend.sh` stamped `202611010238` at **19:38**, then `app.js` was edited at **19:42** for the clearSearch fix and committed at **19:47** *without a second bump* — so the token was **4.5 min older than the file it names**. Any browser that fetched `app.js?v=202611010238` in that window cached the **pre-fix** bytes under the **current** URL and would never refetch: exactly the 2026-10-22 Köppen failure, this time carrying the search fix instead of an overlay. Found by comparing every stamped asset's **mtime against its own token** (not against "the newest token in the page" — `overlay-opacity.js`/`map-presets.js` legitimately hold older independent stamps via `bump_asset_token.sh`, so they are excluded by design). Re-stamped to `202611010609`; all 43 stamped assets now have `mtime ≤ token`. `app.js` stayed at **849,990 B** (the token is 12 digits either way, 0-byte delta — still 10 B under the 850,000 ceiling). **No test compares a token to a file's mtime**, which is why this shipped green; `frontend-hygiene` only checks chunk tokens match `app.js`'s. Tests: 1003 pass / 0 fail (23 runs + 4 in parallel after the bump), `validate-api.sh --quick` ✅. |
| 🧹 **Clearing a search left it in the URL** | ✅ fixed (10-31) | `clearSearch()` deleted the `?q=` query param but never touched the **`/search=<q>` segment that `getMapHash()` writes into the hash**, and the hash is authoritative on boot. Pressing Clear then reloading — or sharing the link — **restored a search the user had already dismissed**: `searchActive` came back true and the canvas never drew (`_lastDrawnCount: 0`, `canvasPins: 23`). That is exactly what the deploy gate measured, because test 9A in `scripts/run_ui_tests.py` reloads immediately after a search-and-clear and asserts `drawn > 0` — so **`scripts/validate-api.sh` failed "DO NOT DEPLOY" on 4/4 runs**, with the purge itself passing (`stored: None, inMemory: 0`) and only the draw missing. Reproduced standalone, fixed by rewriting the hash once the state is clear (`updateUrlHash()` at the end of `clearSearch()`; `getMapHash()` then omits the segment because both of its gates — `searchActive` and the input — are false). **Gate green**, re-verified at load 9.18. Tests: **1003 pass / 0 fail**. Commit `c713999`. |
| ⛅ **Isobars contoured at 2 hPa** | ✅ shipped (10-31) | The worker now contours GFS MSLP at **2 hPa instead of 4**, and the API's `step` param (`2\|4\|8\|16`, default 4) thins that ONE dataset down. The contour of one specific level (say 1000 hPa) does not depend on the interval used to enumerate the levels — level 1000 at 2 hPa is byte-identical to level 1000 at 4 hPa — so filtering to multiples of 4 reproduces the classic synoptic chart exactly, and "more detail" / "less detail" are two ends of one control rather than two datasets. Cost: ~1,008 → ~2,000 lines and ~199 → ~400 KB worldwide (simplified to tolerance 0.144, gzipped); contouring is linear in levels on the 0.25° grid, so the 6-hourly worker absorbs it. The UI defaults the reader to 4 and treats 2 as the close-up choice — a p95 offset is *inside* one step at 4 but a visible fraction of one at 2. (The 2.5 hPa figure quoted here in October was the **audit's false alarm** — it was reading the 1° field against the 0.25° lines; the measured artefact against the field the lines were cut from is **0.029 hPa**, see the 11-04 row above.) Tests: `test_gfs_verify.py` 23 pass. |
| 🔤 **Two-letter state abbreviations now resolve** | ✅ fixed (10-31) | "a lot of people typing in this type of thing". **Nothing resolved them, and both lookups were actively wrong**: `/api/locations/search?q=CA` returned *"Careca"*, *"Can"*, *"Car"* (it prefix-matched word beginnings) and `/api/geocode?q=CA` returned **CANADA**, `WA` → **WESTERN AUSTRALIA**. Nominatim gets the unambiguous ones right (TX → Texas) but has no way to know a US reader means California by `CA`, so the abbreviation is now resolved from an explicit **51-entry table** (50 states + DC) in `city-engine.js`, offline and instant — no extra round trip on a keystroke — with each state's own extent to frame it. `detectStateSearch` is **exact and case-insensitive** (2 characters: `tx`/`TX` are Texas; `tax` and `texas` are not abbreviations) and is consulted at **all three** search paths ahead of the city index. Verified: **TX → 31.32,−100.08 z6 "All news in Texas, TX, US · 91 stories"**, **CA → 37.42,−119.30 z6 · 177 stories**, **WA → Washington · 20 stories**, lowercase `tx` identical. **Two bugs testing caught in my own first version**: (1) the state's box is stored Nominatim-style `[south,north,west,east]` but `bbox=` takes `[minLng,minLat,maxLng,maxLat]` — returning it unwritten gave an **inverted box** (W > E, S > N) and the API answered *"No news found near Texas, TX, US"* while the map framed Texas perfectly; (2) a first pass that accepted any top location had sent `climate change` to Seattle and `ukraine war` to Kyiv. Also tightened `detectCitySearch`'s **prefix match to ≥ 3 characters**: `uk` is a prefix of *"Ukyō Ward, Kyoto"*, so searching a country code flew to a ward in Japan — it now goes to the UK (`458 matches · UK · 227 stories`). Cities/countries/topics unchanged: `tokyo`, `oxford`, `el salvador` → **13.70,−88.91 z9**, `climate change` → world view. **Size discipline**: the table plus the place-lookup bodies (`detectCitySearch` / `cityToBbox` / `citySearchRadius`, 3.4 KB) were moved into `city-engine.js`, leaving thin aliases so **no call site changed** — app.js landed at **849,824 B against its explicit 850,000 B runaway ceiling**, whose own comment says *extract rather than raise*. Tests: `search-state-abbrev.bun.test.js` (13) + `search-place-navigation.bun.test.js` (18). |
| 🔎 **Searching a place now moves the map to it** | ✅ fixed (10-31) | Reported: searching **"el salvador"** did not move to the country. Measured from Sydney (−33.87,151.21 z10) — the search ended at **20,0 ZOOM 2, the whole world**, while the status line read *"… · El Salvador · 82 stories"*: the place **was** resolved and then thrown away. **Cause:** both the search button and Enter call `runSearch({ zoom: "world" })`, and the branch order was `if (zoom === "world") zoomToWorld(); else if (bestLoc) flyTo(...)` — so the world view won on **every** explicit submit and the fly-to-the-place code was unreachable dead code. World view is right for a *topic* whose results are spread over the globe; it is wrong when the query **is** a country, region or city. **The gate is deliberately strict, because neither lookup is a safe oracle on its own**: `/api/locations/search?q="climate change"` ranks **"Climate"** (a place in Seattle, 23 events) first, and Nominatim answers the same query with a **California trail sign literally named "Climate Change"** — so a first attempt that accepted any top location sent "climate change" to Seattle and "ukraine war" to Kyiv. A place now only wins when it accounts for the **whole** query (normalised equality against **both** the geocoder's `display_name` and the location's `place_name`), and it is framed by its own **bounding box** (Nominatim order `[south, north, west, east]`) via `fitBounds`, capped at 25°×40° so "tokyo" — which Nominatim answers with Tokyo *Prefecture*, 20–36 N × 136–154 E including the Ogasawara islands — cannot zoom out past the ask. Both search paths (`runSearch`, `runTextSearch`) fixed the same way. **Playwright-verified** (`scripts/search_place_check.py`): `el salvador` → **13.70,−88.91 z9**, `chile` → −31.76,−71.32 z6, `tokyo` → 35.69,139.69 z7 (city path, unchanged), `climate change` → **world view**, `ukraine war` → **world view**. Two self-inflicted errors caught en route and pinned: referencing `geoMatchesQuery` (which lives only in `runTextSearch`) from `runSearch` threw and killed the handler so the map did not move *at all*, and the first strict-gate attempt was then over-tight. Tests: `search-place-navigation.bun.test.js` (18). |
| 🔥 **"Hot & Latest" showed the same stories every day** | ✅ fixed (10-30) | Reported against `#13.0260,-29.3555,4/time=3d/…`: a **28-day-old** story at #1 under a 3-day filter, unchanged day after day, and `3d` → `24h` changed nothing. **THREE defects reading as one symptom.** **(1) The graph term won the ORDER BY.** `graphBoostExpr` multiplied `connectivity_score` (stored **0–10**) and `same_event_avg_strength` (stored up to **3,357**) as if they were 0..1 fractions, and had **no time factor at all** — measured against the live DB, the graph term reached ~**4,600** while the recency term peaks near **500**, so it decided the ranking outright. Reproduced from the API: items 1–5 were 27–29 days old with 49/14/18/78/11 sources, sitting **above** fresh items carrying **419/330/223 sources**. Both raw fields are now clamped to a fraction (graph ≈ ≤12, a tiebreaker not a dictator) and the **same** `exp(-0.05 × hours)` decay is applied to it as to `source_count`. **(2) No window reached the route.** The client never sent one and the route never read one, so `time=3d` and `24h` were byte-identical — `fetchLiveFeed()` now sends `since=` from the shared `getSinceDate()` (one vocabulary for map *and* panel), `parseSince()` accepts `hours`/`since` on both `/feed/live` and the SSE stream, and the window is **part of the cache key** (without it a 3d request could be served a 24h response). **(3) `setTimeFilter` never refetched the panel** — it only moved the map. **Why it shipped: the expression was written out THREE times** — twice as `graphBoostExpr`, once *inlined* in the stream's 60-second resync — so a fix applied to two would have left one; it is now a single module-scope factory. (The factory takes the sql tag because the file's module-scope `const sql = postgres.sql` is `undefined` at runtime — only `import { sql } from "postgres"` exports a tag — and evaluating the fragment at module scope threw and 404'd the stream route until caught.) **Verified live**: `hours=24` truncates the oldest item to **0.91d** (control 1.42d), and with no window the top is now 0.2–0.9d old instead of 28d. Tool: `/tmp` one-shot probes; test: `live-feed-window.bun.test.js` (13). |
| 🔍 **Console audit of both views: 0 unexplained errors** | ✅ fixed (10-30) | Swept the flat map and the globe with Playwright, collecting **console errors/warnings, `pageerror`, failed requests and every ≥400 response**, then classified each one so designed-in noise could not hide a real fault. **It found one real bug: the globe's Hydrological Basins overlay was 404ing** — it still requested the single `basins.geojson`, which stopped being built when that layer split into `basins_major` (0.05°) and `basins_detailed` (0.01°). Every other globe layer drew; basins drew *nothing*, with no page error to explain why. `loadBasins()` now reads the filename from `meta.levels[]` and `default_level`, exactly as the flat map's `levelUrl()` does — never a hardcoded path, which is precisely how it broke. Verified live: **235 features, both the fill and the line layer visible, zero 4xx/5xx anywhere on the page**. **Second finding: the image proxy cached *every* failure for 30 minutes**, so a 5-second timeout or a publisher's transient 403/503 made a perfectly healthy photo 404 for half an hour — measured on two `romaniatv.net` images whose origin answered **200 in 1.6 s** while our proxy served `cached_failure` 404 (a fresh URL from the same host proxied fine, ruling out the circuit breaker). Failures now carry a **transient flag**: upstream 404/410/400, dead DNS and not-an-image keep the 30-minute ban, while **timeouts, 5xx, 403 and 429 retry after 60 s**. The response stays 404 either way, so the console keeps saying "not found" instead of "our server broke", and the host circuit breaker is unchanged. **After both fixes: 0 unexplained findings.** What is left is (a) image-proxy 404s for photos that genuinely no longer exist upstream — the designed 404 + placeholder path — and (b) MapLibre/WebGL driver warnings from the vendored bundle; the `net::ERR_ABORTED` on `/api/pins/map` is the documented `AbortController` in `fetchPinsForViewport` cancelling a superseded viewport fetch (app.js:11997). Those browser-generated `Failed to load resource` lines are **Chromium's own network reporting, not `console.error`**, so no in-page console guard can filter them — `console-guard.js`'s `image-proxy` patterns only cover what JavaScript actually logs. |
| 🏙️ **City names: verified placement + fixed "just showing up"** | ✅ fixed (10-30) | Reported against `#6.3590,-16.9629,4/…`. **PLACEMENT IS CORRECT** — proved two independent ways, neither using the layer's own code as its oracle: (1) recomputed each city's expected screen point with Web Mercator arithmetic done in the checker, worst deviation **0.6 px** across 188 painted labels; (2) looked for the label's white fill in the actual screenshot at those points — **4/4 visible**, the other 6 correctly skipped as covered by an open panel (`elementFromPoint` showed `DIV.leaflet-control-layers` / `DIV.live-item-body`, not a wrong coordinate). The canvas anchor (`left:-8 top:-450` == `containerPointToLayerPoint(0,0)`) is the part that would make a draw self-consistent yet wrong on screen, so the pixel pass is what closes that gap. **THE TOGGLE WAS THE REAL BUG.** `init()` restored `localStorage["xyzo.cityLabels"]` unconditionally — the comment promised "a bare revisit (no URL hash)" but no code checked for a hash, and the hash-apply path only ADDS, so nothing could turn it off: with the preference set, a link listing seven *other* overlays arrived wearing city names. **It is not just city names — nine modules do this** (city-labels, mag, temp, lightning, ocean, salinity, phytoplankton, transport and the `field-layer` family behind CAPE/IVT/wave/relief) and none checked the hash. Fixed with **one gate** at the boot-time hash apply (a URL that enumerates overlays removes anything on the map it does not name, reading the map itself rather than `_activeOverlayNames` — a programmatically-restored layer may never fire `overlayadd`), not nine copies of a guard. The gate also **snapshots and restores `xyzo.*`**, because removal goes through each module's `onLayerToggled(false)` and was overwriting the user's saved preference to `'0'`: following a link must not change what you had chosen. Bare revisits still restore (verified: 4 fresh browser contexts, preference written with `add_init_script` so it precedes any app code — a reused context leaks state between cases and lies about this). Tool: `scripts/city_labels_check.py`; tests: `overlay-restore-gate.bun.test.js` (10). |
| ✨ **Cool maps · ⭐ default map · ↺ Clear** | ✅ shipped (10-30) | Three related asks, one module. **(1) CURATED "COOL" MAPS** — nine presets at launch (`🌍 Earth portrait`, `🌬️ Wind map`, `⛈️ Storm watch`, `🦠 Living ocean`, `🧭 Hidden forces`, `🌌 Night lights`, `🌱 Climate skin`, `🛣️ Street mode`, `🪨 Geological`) as one-click emoji chips in the layers dropdown, above the base layers. Each preset is a **real app hash** (`#lat,lng,zoom/density=/overlay=slug@pct,…`) parsed by the same grammar a shared URL uses, so a preset, a pasted link and a saved style can never diverge — and every slug in them must resolve **deterministically** — pinned as an explicit `LAYER_SLUGS` key where app.js's 850,000-byte ceiling allows, or as the exact slugified `LAYER_NAME` of its module where it does not (see the 👥 row above). A substring-scan resolve would silently apply nothing after a rename, which is what the test forbids. The grammar also carries **`iso=`** (the isobar detail) and **`wind=<style>:<colour>`** (how the wind is drawn and coloured) — settings that used to be silently dropped, so a preset naming them opened the isobars at the reader's own step and the wind in the reader's own rendering. **(2) FIRST VISIT** — with no stored state at all, the site opens the showcase preset **only if the machine can carry it** (`MapPresets.deviceTier()`: no save-data, no 2G/3G, ≥4 cores, ≥4 GB if reported; a phone-sized screen is demoted unless it admits ≥8 GB). Thin machines get `🌱 Climate skin` (Köppen PNG tiles + city names — no binary grids to download). **SUPERSEDED 2026-11-14: thin machines now get `🛰️ Satellite` — the bare satellite view, no overlays at all** (the city names alone pull a 1.16 MB index, so the "light" map was not light; see the row at the top of this table). **(3) YOUR OWN DEFAULT** — ⭐ *Save as default* (⚙ → MY STYLE) stores view + base + every overlay + opacity + density; a **Next visit** picker chooses *Last used* (the default — every state change auto-saves to `localStorage["xyzo.lastMapState"]`, debounced off `updateUrlHash` and **flushed on `pagehide`** so a tab closed mid-debounce keeps today's map), *My default*, or *✨ Cool*. **A URL hash always wins** — the boot plan is consulted only after the hash and `?base=&overlay=` paths, because a shared link is an instruction, not a preference. **(4) ↺ Clear / ⤢ Reset** in the same panel: Clear removes every overlay (base layer and camera untouched); Reset is factory state — world view, Satellite, opacities back to each layer's **captured** default (Leaflet's `setOpacity` writes into `options.opacity`, so the original must be remembered before any slider moves), density Medium. Corrupt or empty stored states are discarded rather than applied — an empty state would run the removal half and strip the map bare. Tests: **28** in `map-presets.bun.test.js` + full suite **907 pass / 0 fail**. |
| 🌍 **3D globe: overlays verified + 2D↔3D handoff** | ✅ fixed (10-30) | Audited all 15 globe overlays with Playwright (`scripts/globe_audit.py`) — each toggled ON **in isolation**, then checked in-page for layer existence, visibility, source type/load state, plus a colour-diversity read of the screenshot (MapLibre does not set `preserveDrawingBuffer`, so `readPixels` returns all zeros — the verdict reads the PNG). All 15 render. Two real defects found and fixed. **(1) THE TEMPERATURE WAS THE WRONG COLOUR.** `globe.js` indexed `meta.ramp`'s stops as if they were evenly spaced in °C (`step = (hi-lo)/(n-1)`), but the ramp's gaps run 4.2, 4.9, 3.5, 2.1 — so it landed up to **+4.9 °C too warm**, mean RGB distance 38, **worst 113.9 at 0 °C** (globe painted lime-yellow where the flat map paints green), and **19 of 36 sampled temperatures** disagreed visibly. It now interpolates by each stop's real `c`, the same arithmetic `temp-layer.js` has always used. A comment in the same file had asserted the ramp "is uniform" — false, and it is what let the bug ship; both the arithmetic and that claim are now under test. **(2) SHARED LINKS WERE BEING DESTROYED.** The globe's initial `moveend` fires within 250 ms and rewrites `location.hash` from DEFAULT overlay state, before the `load` handler could read the incoming one: a link asking for 12.35,76.54 with two layers on came up at **22,10 zoom 2.1 with every layer off**. The hash is now captured at module scope and the writer refuses to run until it has been consumed. **(3) 2D↔3D handoff did not exist at all.** The globe button was a bare `href="/globe"` and "Back to the map" a bare `href="/"` — switching views threw away position, overlays and every opacity, and neither page read the other's storage. New `view-handoff.js` translates between the two vocabularies (the flat map emits `temperature`, `magnetic`, `soil-soilgrids`, `cropland-esa`, `land-cover-esa`, `geology-macrostrat`; the globe keys `temp`, `mag`, `soil`, `cropland`, `landcover`, `geology` — **six of fifteen would have dropped silently** through the globe's `if (!st) continue`). Verified end-to-end with Playwright, 6/6: `scripts/globe_handoff_check.py`. |
| 🎨 **Magnetic visual pass: colour + two bugs** | ✅ fixed (10-30) | A Playwright sweep of all eight fields on both views (screenshots + the real grids rendered offline) turned up two bugs and one look to fix. **(1) The magnetic opacity slider did nothing on the flat map** — `MagLayer.setOpacity()` restyled only the contour lines while the colour wash, the visually dominant half, stayed pinned at its creation value: with the wash on, dragging the WHOLE slider moved the picture's mean luminance from **190.5 to 190.8**. It now drives both halves through `addWashToMap()`, which also pushes the slider's value onto the container (a GridLayer does not apply its `opacity` option the way TileLayer does) — now 190 → 178 → … in lockstep with `container.style.opacity`. (The globe already drove both; it was never the broken one.) **(2) The globe's four component chips rendered EMPTY** — the globe reads chip text from `meta.fields[k].label` and the worker never published one, so `magEsc(undefined)` gave `""` and a user could not tell which button picked what. The label is now published, with a fallback to the uppercase component letter for a stale meta. **(3) The ramps were redesigned by RENDERING THE REAL FIELDS**, not by judging swatches: the original neon-green plateau had green on both sides of zero (and the ΔD wash, whose plateau covered most of the globe, was a green ball); the first replacement used an ice-white centre and came out *washed out* over the half of the map that sits inside the plateau. The shipped ramp is a **saturated cyan centre (#00e5ff) with saturated violet/azure and gold/crimson wings and not one green stop** — `verify()` now fails a green-dominant stop — and every plateau was narrowed (D ±10° → ±6°, I ±5° → ±3°, ΔD 6′ → 4′/yr, ΔF/ΔH 20 → 12 nT/yr) because a wide flat band spends half the map on one colour. Tests: **879 pass / 0 fail** frontend, **87** worker. |
| 🧭 **Magnetic field — 4 components × 2 modes** | ✅ shipped (10-30) | The overlay published **D and I only** (plus ΔD/ΔI). It now publishes **D, F, H, I × (main field \| change per year) = eight selectable fields** — the two chart series NCEI tabulates as its Miller-Projection "Main Field" and "Secular Variation" maps — each with its own contour family, colour wash, ramp, label spacing and probe value: isogonics / isodynamics / isohorizontals / isoclinics for the mains, isoporics + `isoporics-{i,f,h}` for the rates. **Three traps, all gated:** (1) **per-field Int16 scales** — one scale cannot hold a ±180° angle *and* a 67,000 nT magnitude, so `meta.grid.scale` stays 100 as the default for the original four and `meta.fields[k].scale` is what the browser divides by (F needs 0.25, H needs 0.5); `verify()` fails a plane that would clip. (2) **per-field blackout masking** — only D and ΔD are undefined where H collapses (ΔD divides by H²); F is at its *strongest* there, H is merely small and I runs smoothly to ±90°, so blanketing all eight would delete the poles from exactly the charts that show them best. (3) **ramps by shape** — F and H are one-sided magnitudes, so they take a sequential ramp; a diverging one would paint half of a never-occurring negative range in the colour that means "negative". Two selector rows in the layers dropdown (component + value, built from the tables so a field added to the worker appears without editing HTML), a caption naming the field and unit under the colour bar, and **the 3D globe carries it too** — one line layer + one colour wash swapped to the selected field, under its own opacity slider, entirely driven by `meta.json` (globe.html has no Leaflet, so it may not keep a second field table). NOAA's published contour shapefiles are recorded in `meta.shapefiles` as the upstream product; the overlay still computes from the vendored `WMM.COF` because those shapefiles are **lines with no grids** — the wash and probe need grids, and colour from one source and lines from another is how the two drift apart. Tests: **844 pass / 0 fail** frontend, **86** worker (`test_magmap.py`). |
| 🧹 **Crash cleanup + tree close-out** | ✅ done (10-30) | Several parallel AI sessions died mid-task, leaving **1,039 modified + 126 untracked files** and no commit. Audited the whole tree (no conflict markers; every JS file parses; 6 stale `.claude/worktrees/` left behind and removed — verified first that they held no unmerged work). Fixed five things that were genuinely broken: **(1)** `HRRR_DOMAIN_QUD` typo in `api/src/routes/weather.ts:62` — a `ReferenceError` waiting to fire the moment HRRR rows exist, breaking `/api/weather/isobars`. **(2)** **Cape and IVT were unreachable**: both had modules, published data and **enabled systemd timers rebuilding that data every cycle**, but neither was registered in `WEATHER_OVERLAYS` nor `init(map)`-ed in `app.js` — the worker published into the void. **(3)** Two **pane z-index collisions** (cape 346 on wave 346; languages 357 on phytoplankton 357) — fixed to 348 and 364, and the uniqueness test that missed them was rewritten to **scan the source** instead of a hand-maintained list, because a duplicate check over an incomplete list can never fire. **(4)** **`feedback-dialog.js` was 0 % reachable** (never `<script>`-loaded, never called) and its Report tab POSTed to `/api/pins/:id/report`, **an endpoint that did not exist** — added the endpoint against the existing `news_quality_reports` table (7 tests) and wired the dialog as a new popup button. **(5)** Three `meta.json` files were missing `license`/`attribution` — fixed in the **generators** (`windmap.py`, `tempmap.py`, `etopo_build.py`), not the artefacts, because the 6-hour timers overwrite them. Tests: **828 pass / 0 fail** frontend (was 784/5), worker 908/22 (all pre-existing), API 285/113 (all pre-existing). ~2.1 GB of regenerable overlay tiles now gitignored (was untracked *and* unignored — one `git add -A` from committing it). |
| 📱 **Mobile close-button sweep** | ✅ fixed (10-30) | A full mobile + 3D-globe review, driven on a real iPhone-14-Pro Chromium, found **five dismiss affordances that worked on desktop and failed on a phone**. (1) The layers **✕ stayed in the DOM after the panel collapsed** and sat directly on top of the stack-icon toggle — after the first ✕ the layers panel could **never be reopened**, on either device. (2) The touch toggle hand-rolled the open and never called `layersControl.expand()`, so the panel came out **3,078 px tall on a 660 px phone** and **26 overlays were unreachable**. (3) `#help-me-btn` (z-index 9998) covered the bottom bar's (z-index 500) right end — on a phone that is where the **⚙ tools button and the Markers button live**, so the entire control menu was untappable. (4) The popup was sized and auto-panned from Leaflet's **pre-`zoom`** measurement while the content wrapper renders at `zoom: 1.15` (the A+ text size), pushing the **✕ Close off the right-hand edge** of a 393 px screen. (5) The 3D globe panel had **no close affordance at all** and covered **76 % of a phone screen**. Full write-up: **"Mobile & 3D-globe review"** below. |
| 🔤 **Legibility sweep (base font sizes)** | ✅ fixed (10-30) | The A / A+ / A++ text-size control only scales **nine selectors** (`.live-panel-*`, `.leaflet-popup-content-wrapper`, `.explore-panel > *`, `#help-panel > *`, `.overlay-card > *`, `.bar-dropdown > *`, `.nav-links`). Everything the map is actually operated through — the layers dropdown, its legends, the bottom bar, the control menu, the probe cards and the hover HUD — was **not on that list**, so it stayed at 9–12 px whatever the user picked: `styles.css` carried **148 uses of 11 px, 112 of 10 px, 75 of 12 px**. Raised the BASE by 2 px across four scopes (80 rules) so the zoom control keeps compounding on top: 9→11, 10→12, 11→13, 12→14. Plus the two `em`-sized rules in Leaflet's vendor CSS, which inherit a base we never set — the **layer row**, the most-touched control on the map, was rendering at **12.75 px** and is now an explicit 14 px. Four knock-on defects the sweep exposed, each fixed: the control menu's chips wrapped to two lines at 13 px (**back to 11 px + `white-space: nowrap`**); "Markers" in the bottom bar was clipped to a **46 px box holding 76 px of text** because the hide-labels rule matched `span[data-i18n]` and `#markers-dropdown-label` is a plain `<span>`; legend tick labels overhung into the unit column once they grew, and **centring them with `translateX(-50%)` was wrong** — `.leaflet-control-layers-scrollbar` has `overflow-x: hidden`, so the leftmost label lost its minus sign; and the **Help Me pill covered the layers panel's opacity readouts** on a phone (it cleared the bottom bar after the earlier fix, but nothing cleared the panel). Full write-up: **"Legibility sweep"** below. Tests: **907 pass / 0 fail**. |
| 📐 **Control menu: the clear band** | ✅ fixed (10-30) | The ⚙ menu was anchored to **typed constants that had drifted from the real chrome**, so it collided with three different pieces of furniture depending on which anchor you fixed — measured on a 393×660 iPhone 14 Pro. **(1)** `bottom: 58px` was the **bar's height, not its top edge (70 px)** — the bar is itself 12 px off the viewport bottom, plus `env(safe-area-inset-bottom)` on a device with a home indicator — so the menu sat **12 px INSIDE the bar** and its last row, "AI / Help", was half-hidden. **(2)** There was **no top constraint at all**: the menu is **799 px tall in a 538 px clear band** (the band runs from `#top-bar`'s bottom edge at y=52 to `#bottom-bar`'s top edge at y=590), so growing upward from the bottom put its top third under the search pill — and `--top-band` is **not** the fix, because it measures the map control stack *below* the pill. **(3)** `#help-me-btn` (z 9998) floated **OVER** the dropdown (z 10000) and covered **~5 rows — "MY STYLE", "Save this view", "Next visit", "My default map", ~45,000 px²** — and on a 393 px phone the menu is centred and spans the whole band, so there is nowhere the pill could move to. **The fix measures both edges and parks everything else in the band:** `publishChromeEdges()` (renamed from `publishBottomBarHeight()`, which only ever measured the bar) writes `--bottom-bar-top` as `innerHeight − bar.top` and `--top-chrome-bottom` from `#top-bar`'s own bottom edge, re-measured on resize / rotate / i18n label landing; `.bar-dropdown` reads both and derives `max-height` from them, so the menu scrolls inside a box bounded by chrome that moves. The scroll needed **`min-height: 0` on the shell plus `flex: 1 1 auto` on `.control-menu-inner`** — without both the inner *stretches* to its 918 px content, `scrollHeight === clientHeight === 918`, and `overflow-y: auto` never engages; the 550 px shell then clips silently. `body[data-dropdown-open]` (set in `closeOtherMenus`, cleared by ONE document click listener rather than six close paths that would drift) parks the Help Me pill. Also fixed while in here: **the menu was 19 px too narrow** — shrink-to-fit settled at 323 px while the widest row needed 333 px, clipping the "✨ Cool" chip at every text size; `width: max-content` re-centres at 352 px with 20 px of margin, so it cannot push off-screen. Measured end-to-end: ✕ closes, all 5 sections reachable, "AI / Help" 24 px clear of the bar, "✨ Cool" fully visible, desktop 1440×900 unregressed. Tests: **24** in `control-chrome-collision.bun.test.js`, suite **943 pass / 0 fail**. |
| 🐾 **Wildlife source network** | ✅ shipped (10-29) | **101 new wildlife, conservation and biodiversity sources** — specialist NGOs (Mongabay, BirdLife, TRAFFIC, Panthera, Wildlife Trust of India, Wildlife SOS), government agencies (USFWS, IUCN, CMS, Ramsar, WOAH, Parks Canada, SANParks, Kenya Wildlife Service), science journals (PLOS Biology/ONE, Nature, ScienceDaily, Phys.org, Frontiers) and regional desks (Mongabay India/Indonesia/Africa/Latam/Brasil, BirdLife South Africa, ProAves, Jocotoco). Every feed was **probed** (robots.txt + HTTP + parse + non-empty) before it was written — a comment feed, a podcast enclosure feed and a 0-entry feed are all rejected. Registry and method: **"Wildlife Source Network"** below. |
| ⚡ **Lightning density** | ✅ shipped (10-29) | WWLLN Global Lightning Climatology, **5 arc-minutes ≈ 9.3 km** — six times finer than the NASA LIS/OTD map everyone shares, and 2020-2022 instead of 1995-2013. **Annual mean + twelve monthly fields** (the ITCZ's seasonal walk is the whole point of the dataset), a probe, and an opacity slider. CC BY 4.0. |
| 🦠 **Phytoplankton (Darwin)** | ✅ shipped (10-29) | The MIT Darwin Project's global ocean ecosystem model (1994-1999): **which** phytoplankton dominates each patch of ocean and **how much**. The published distribution is a *rendering* (2,191 daily PNG frames), so the numbers are recovered by inverting the dataset's own colour bar — three traps, each caught by the `verify()` gate. MIT Licence. |
| ⚠️ **World-view pins timing out** | ✅ fixed (10-29) | `/api/pins/map` ranked **1.63 M articles** with **two** window functions — the second was a duplicate of the first with an identical partition, and the two disagreed on **15,293 of 416,127 groups** because `ROW_NUMBER()` breaks ties arbitrarily (the map could flicker between two stories of one event). Plus a `guardrail` field the frontend has always read but the API never sent. **10.5-15.8 s → 1.36 s**, and the "System Notice: temporary interface issue" banner is gone. |
| ⚠️ **image-proxy returned 502** | ✅ fixed (10-29) | A missing *third-party* photo logged `status of 502` — as if our server had broken. It hadn't; a remote image was gone. Now 404 (with 413/415 kept for request-shaped failures), so the console says "not found" instead of "the site is down". |
| 🌍 **Köppen licence + resolution** | ✅ fixed (10-29) | Source was **CC BY-NC-SA 2.5** (NonCommercial *and* ShareAlike) — the site's one licence exposure. Swapped to **Beck et al. 2018, CC BY 4.0, 928 m**. And the swap had NOT delivered the detail: the pipeline downsampled the source to 5.6 km before warping, and `MAX_NATIVE_ZOOM = 5` made Leaflet blow z5 tiles up 4× at every deeper zoom. Now warps the source **straight to 1,223 m/px** and serves **z7**, within **1.3×** of the source. |
| ⚠️ **Source placement pileups** | ✅ fixed | One source owning one capital: dev.to (tagged `country=ML`) put **12,368 stories on Bamako**, and 141 pan-Arab sources tagged `country="ME"` (ISO **Montenegro**) put **41,106 stories on Podgorica**. The map showed "103 Stories in Bamako, ML" — all dev.to blog posts. Root cause, gate and repair tooling: **"Placement Integrity"** below. |
| ⚠️ **API 502 storm** | ✅ fixed | `xyzo-api` restarted **28× in 6 h**; each restart ran an 84-second `ExecStartPre` validation → an 84-second outage, Caddy answering 502. **"API Uptime"** below. |
| ⚠️ **Links never rendered** | ✅ fixed | `/api/feed/links` scanned all 36.6 M link rows per request (65 s+) → the browser's fetch timed out, so the arcs never appeared. Now driven from the articles in view: **0.1–3 s**. |
| ⚠️ **Map missing on first load (Firefox)** | ✅ fixed | The async stylesheet arrives after the script → Leaflet forces `position: relative` inline → the map container stays **0×0**. Reproduced, fixed, pinned by a test. |
| ⚠️ **3D globe button hidden under the live panel** | ✅ fixed (10-28) | The zoom bar grew to 4 buttons (+, −, world, 3D globe) but `--zoom-stack` was still a 3-button height, so the live panel covered the bottom button. `syncZoomStack()` now measures the real bar. The 3D button is also a distinct **ringed-planet** icon now, not a copy of the world-view globe. |
| ⚠️ **Basin probe didn't own clicks** | ✅ fixed (10-28) | `BasinLayer.blocksClick()` existed but was never checked in app.js's click-to-submit guard — the basin probe and the submitter overlay both fired on the same tap. |
| ⚠️ **Geology contacts invisible on dark basemaps** | ✅ fixed (10-28) | The USGS/GSC contacts WMS draws black lines; without the CSS invert they vanished on the dark tiles. |
| ⚠️ **mag-layer.js unstamped** | ✅ fixed (10-28) | Missing from `bump_frontend.sh`'s ASSETS, so its `?v=` token went stale on every deploy. |
| 🖱️ **Hover HUD** | ✅ shipped (10-28) | One cursor-following card with three user-selectable modes (Off / Pins / Everything), replacing scattered probe boxes and the textless pin ghost. Study: `docs/TOOLTIP_STUDY_2026-10-28.md`. |
| 🌍 **Languages** | ✅ shipped (10-29) | **8,889 Glottolog language points** (CC BY-SA 4.0), replaced 1,473 Native Land Digital polygons. Points so co-spoken languages all show; a **Probe** lists every language under the cursor (675 in the PNG highlands). Dot size = how many languages share a spot. |
| 🅰️ **Text size · double-click submit · saved styles** | ✅ shipped (10-29) | A / A+ / A++ text-size control (default **A+**, applied before first paint so nothing flashes); empty-map **double-click** opens the submitter — a single click only leaves a hint (elderly accidental-tap guard, `doubleClickZoom` disabled); **MY STYLE** saves/restores view + base layer + every overlay with its opacity in one click. |
| 🧂 **Sea surface salinity** | ✅ shipped (10-29) | NOAA GFDL CM2.6 surface salinity (PSU) — frame 0 of NOAA SOS's 1,094-day animation, land masked to transparency, painted by the wrapping GridLayer. Checkbox + opacity slider + `overlay=sea-surface-salinity@pct` share links; public domain, licence row in `docs/DATA_LICENSES.md`. |
| 🏙️ **City names off-centre** | ✅ fixed (10-29) | Labels were drawn at `latLngToContainerPoint` on a canvas that *rides* Leaflet's pane translate — which **persists after every drag-pan** (only a zoom resets it) — so every label sat paneOffset from its city: correct on a fresh load, drifting with every pan. The canvas now re-anchors to the screen origin on each redraw, the saved on/off preference restores on revisit, and labels un-hide only after the fresh frame paints (no stale flash). |
| 💨 **Wind off-centre + probe** | ✅ fixed (10-29) | Same pane-translate bug in two places: the streamline canvas (re-anchored on resize **and** every moveend) and the hover probe (attached to the map container, never the transformed pane — the tooltip sat paneOffset from the cursor). |
| · · · **Leader dots** | ✅ shipped (10-29) | Every overlay row in the layers dropdown trails dotted leaders from the layer name into its opacity slider — with 20+ rows the pairing no longer reads by position alone. Decorative: `aria-hidden`, `pointer-events:none`. |
| 🛰️ **Satellite on a lone click** | ✅ shipped (10-29) | Right-click stays the **browser's native menu everywhere** (Inspect, Save image, extensions — a page cannot add items to it, and nothing may `preventDefault` a contextmenu; pinned by test). A lone empty-map click still shows the double-click-to-submit hint, and **after the 500 ms window closes** the chip morphs into "🛰️ View satellite of this spot": a popup with a live **Esri World Imagery mini-map** plus **Google Satellite** and **Bing Aerial** deep links for that exact point. A fast double-click still submits — the morph is killed before the submitter opens. Two hard-won rules from its bug hunt: the mini map uses **plain tile requests, never `crossOrigin`** (Esri answers Origin-bearing CORS requests with flat placeholder JPEGs where a plain `<img>` of the same URL returns real imagery), and starts at **z12, not z16** (Esri has no z16 imagery for much of the world — ocean, interior Suriname — HTTP 200 + a flat `#CCCCCC` JPEG, which shipped as "the map doesn't show up"). The popup's close ✕ also had to be exempted from the content's `stopPropagation` — the central closer **delegates** from the popup element above. |
| 🗺️ Layers dropdown | ✅ reworked | One place for layers: overlays + per-layer opacity sliders + **🔗 Story links** + the Köppen class key. Nothing floats over the map any more. |
| 📍 **Markers off · panel stays open** | ✅ shipped (10-29) | Master **📍 Markers** checkbox at the bottom of the layers dropdown turns every pin off in one click (canvas clears, `activeModes` empties) and restores single-marker mode when switched back on. The panel no longer auto-collapses on an outside click (`collapsed: false`) and carries an explicit **✕** to close it. DOM pins also get a hover **✕** to dismiss one marker at a time. |
| ⛅ **HUD reads all 13 layers** | ✅ shipped (10-29) | The Hover HUD's "Everything" mode now samples **isobars (interpolated `≈1008 hPa` between bracketing lines), waves, cropland/land cover, relief, rivers (nearest named) and languages** on top of the original seven — plus a **per-layer checkbox list** (⚙ → MAP → Hover, only in Everything mode) to silence any individual reading, persisted in `localStorage["xyzo.hoverHudOff"]`. **The list has grown since (21 samplers on 2026-11-05) — see the System Health row on the HWSD soil type.** |
| 🌍 Köppen climate overlay | ✅ shipped | World climate classification (30 classes) under the news pins, built from Beck et al. 2018's 1-km grid (CC BY 4.0). |
| ⛅🌡️ Wind + isobars + temperature | ✅ shipped (10-26) | The three NOAA GFS fields (pressure contours, 2 m temperature colour field, 10 m streamlines), all cross-verified against each other by `worker/gfs_verify.py`. |
| 🟫🌾💧🧭🌊🪨 Six more overlays (10-28) | ✅ shipped | Soil (SoilGrids), Cropland/Land Cover (ESA), Rivers (Natural Earth), Magnetic field (WMM2025), Hydrological basins (FAO), Geology (Macrostrat/USGS) — each with a legend, a probe where it makes sense, and an opacity slider. |
| 🌐 3D globe (10-28) | ✅ shipped | `/globe` — MapLibre GL on a real sphere, same overlays and pins. Settings (overlay on/off, opacity, projection) **persist across visits** in `localStorage["xyzo.globe.settings"]`; popups are dark-styled to match the flat map. |
| 🎨 Basin colour schemes (10-28) | ✅ shipped | Blue / red / black switcher in the basin legend, persisted in `localStorage["xyzo.basinScheme"]`. |
| 📰 Daily digest + video | ✅ shipped | The day's stories, curated → written → mapped → narrated → uploaded. |
| 🆘 "Help Me" chat | ✅ shipped | The floating chat answers "what's happening, and what can I do about it?". |
| 🧹 Dead-NN cleanup (10-26) | ✅ shipped | Removed the geolocation NN (never placed an article, trained on zeros, 3.9 GB of unread predictions). Dropped 5 unused indexes (3.6 GB). **22 GB reclaimed** — DB 86 → 68 GB, disk 92% → 91%. |
| 🔗 Story links polish (10-26) | ✅ shipped | Arcs rendered **gray** for every link because `EDGE_COLORS` had no `ai` key — and `ai_detected` is 97% of all edges. Tooltips said the word "linked" because the NN's own reason string was SELECTed then thrown away. Both fixed; arcs now carry "same story · 75% match @ City". |
| 🧪 Frontend test hygiene (10-28) | ✅ shipped | `frontend-hygiene.bun.test.js` (18 tests): no shadowed top-level declarations in app.js, every `*-layer.js` loaded **and stamped** by bump_frontend.sh, no direct `console.*`, globe assets stamped. `overlay-contracts.bun.test.js` extended to all 10 overlays (boot, pane z-index, opacity, `blocksClick`). |

### Longer history

Major fixes shipped on 2026-09-26 (details & remaining items in FIX_NOTES):

| Subsystem | Status | Notes |
|---|---|---|
| RSS/JSON ingestion | ✅ working | ~2,000 articles/h; lease system sound; lease-leak + per-source crash isolation fixed; **smart scheduling** shipped (value-weighted failure backoff, bounded feed parsing, source retirement tooling — see "Fetch Scheduling & Fleet Hygiene") |
| ⚠ Fetch outage 2026-09-26 | ✅ fixed same day | The 09-26 smart-scheduling deploy passed `max_redirects=6` to `httpx.Client.stream()`, which doesn't accept it (it's a constructor arg on httpx ≥0.28). Every source fetch raised `TypeError`, swallowed by the per-source crash-isolation handler → **ingestion dropped to ZERO ~11:00–18:12 PDT** (daily volume 24k vs 60k baseline; watchdog did not kill the 9-h-stuck `xyzo-fetcher`). Fix: redirect cap moved to the `httpx.Client(...)` constructor in `fetch_all`; `test_fetch_smart_policy` now pins the *signature* of `stream()` kwargs so a per-request kwarg regression can never pass tests again. The bulk-claim lease thrashing noted the same day is **fixed 09-28**: claims are now batch-limited (`CLAIM_BATCH_SIZE=200`, env `XYZO_FETCH_CLAIM_BATCH`) with claim→fetch→re-claim per batch — verified live at ~184 in-flight leases vs ~2,400 before. |
| ⚠ Fetch outage 2026-09-29 | ✅ fixed same day | The **09-28 batch-claim restructure** (commit `e853efb`) made `fetch_all()`'s claim loop non-terminating: its only exit was `len(sources) < CLAIM_BATCH_SIZE`, but `RECENT_SUCCESS_WINDOW_S=300` re-admits a source 5 min after success while a full ~3,690-source sweep takes 15–40 min — so every claim returned a full batch and **`fetch_all()` never returned**. `worker/run.py` runs *one cycle and exits* and calls fetch **before** auto_categorize/geocode/cluster, so those steps never ran for 26 h: fetch kept inserting (57k/day, looks healthy) while **75k articles stranded at `status='pending'` with no coordinates** → the map showed ~155 stories instead of ~50k (10,624 polls/h across only 2,234 sources, same source 5×/hour). Fix: `seen` set of ids claimed per sweep, break when a claim yields nothing new, hand repeats' leases back, plus `FETCH_MAX_CLAIMED_PER_SWEEP` (env, default 8000). Pinned by `TestSweepTermination`, which drives `fetch_all()` against a pool that never drains and **fails on the pre-fix tree**. Also: `health_monitor` never saw it because every stat watched the *fetch* layer — added `pipeline_stuck()` (backlog >1000 AND auto_categorize silent 30+ min). Full write-up: `docs/FETCH_OUTAGE_2026-09-29.md`. ⚠ Requires `sudo systemctl restart xyzo-fast-fetcher xyzo-fetcher` to load the fix. |
| Monitoring was dead | ✅ fixed same day | Every xyzo cron line redirected into `/var/log`, which the non-root `asher` crontab cannot create files in — and a failed redirection aborts the command, so `health_monitor` (*/5), `timer_watchdog` (*/5) and `health_monitor --cpu-guard` (*/2) had **never executed at all**. Repointed to `/var/www/vhosts/xyzo.org/logs/`. |
| Timestamps | ✅ fixed | `time.mktime`→`timegm` everywhere (audio/video/discover variants fixed 09-26 too); new-data canary green (0.4% future-dated); historical skew backfill ready (`scripts/backfill_published_tz.py --check` first!) |
| Web-source scraping | ✅ recovered | Scraper bug (RobotsVerdict unpack) fixed; 951 web sources now poll max once/24 h and produce **~3,850 articles/day** (was 0) |
| Geocode / localize | ✅ mostly fixed | `upsert_location` restored (new cities bind, re-evaluate flow live); 429/5xx now retried instead of parked `unlocated`; 76 k parked articles being reset; ambiguous bare names get source-country hints |
| robots.txt compliance | ✅ improved | gov/university politeness floors now preserved across failures; watchdog thresholds fixed; dead `fast_update` removed |
| Source-based placement | ✅ fixed | Sep 26: `news_source_geography` city_id was resolved against `world_cities` while IDs come from `news_locations` — collisions pinned e.g. Azerbaijani stories to Kajansi, UG. Lookups corrected + name-validated, `_nearest_city` now honors its country hint, cross-country profile rejections added; 50,826 mislocated articles reset & re-processed, 542 mislabeled `news_locations` rows repaired. ⚠ Profiles have **no scheduled rebuild** — run `python3 -m worker.source_profiles --all --days 30` periodically |
| Trending | ✅ fresh | `xyzo-trending.timer` (hourly) runs `event_velocity` + `compute_event_stats` + tfidf/pmi — `news_event_velocity` verified current |
| API security | ✅ mostly hardened | shutdown kill-switch auth fixed + complaint rate-limited; SSRF guard (`lib/ssrf.ts`) on sniff/image-proxy; public writes gated; pins/map hidden_at/source_type/cache-key/bbox-400 fixed |
| Frontend XSS | ✅ closed | popup URL sinks escaped + scheme-allowlisted; search/explore/discovery innerHTML escaped; Explore open no longer auto-writes sources |
| Deploy integrity | 🟡 partial | prod→dev synced, `?v=` bumped; content-hash pipeline + git-based deploy still open (FIX_NOTES §12-D) |
| DB hygiene | ✅ started | 4 dead indexes dropped, retention timer installed (`xyzo-retention`), `geocode_attempts` + pins `article_id` columns added |
| User interactivity | ✅ shipped 09-28 | Click-to-submit community stories (two-stage moderation), news-URL submission queue, article recommendations, News/Community layer toggles, BigInt serialization audit (2 live 500s fixed) — see "Community Submissions & User Interactivity" |

**Remaining open items are tracked with `[ ]` boxes in `docs/FIX_NOTES_2026-09-26.md`.**

---

## Placement Integrity (2026-10-22)

The map places a story where it happened. When the placement code lies,
the map lies with it — and the fastest way to lose a reader is a pin that
claims 103 stories in a city that has none.

### The bug

`auto_categorize._source_fallback()` places every article the fast path
could not locate onto **a single city of the source's country**. That is
a reasonable default for a national outlet ("no place mentioned → it came
from our newsroom") and a disaster when the source's country is wrong:

| Source | Tagged country | Landed on | Articles |
|---|---|---|---|
| "DEV Community" (dev.to — a global programming blog) | `ML` (Mali) | **Bamako** | 12,368 |
| 141 pan-Arab papers (Mehr News, Asharq al-Awsat, …) | `ME` ("Middle East") | **Podgorica** (ISO Montenegro) | 41,106 |
| ReliefWeb (UN) | `UN` | New York (UN HQ) | 2,344 |
| GuruFocus (financial wire) | `US` | Fargo, ND (from the text "Wells Fargo") | 25,950 |

It also **fed itself**: the per-source geographic profile
(`news_source_geography`) counted the fallback's own placements, so the
pinned city became the source's "top city" and the next cycle pinned
even more articles there.

### The fix (three layers)

1. **A gate** — `_source_geo_is_country_specific()` in
   `worker/auto_categorize.py`. A source may only use the single-city
   fallback when its own country really is its centre of gravity. The
   evidence is its 30-day geographic profile:

   | Situation | Verdict |
   |---|---|
   | No country (a global platform) | refused |
   | `UN` / `EU` / `GLOBAL` (not countries) | refused |
   | `ME` + region `MENA` (the Middle East, not Montenegro) | refused |
   | <10 % of its own-text articles in its own country | refused |
   | otherwise | allowed |

   A refused source leaves the article **unlocated** — the honest answer
   for a story that never says where it happened.

2. **Clean profiles** — `news_source_geography` is now computed from
   **content placements only** (`auto_categorize_method IS DISTINCT FROM
   'source_fallback'`), so a fallback pile can no longer become a
   source's "top city" and re-inflate itself.

3. **Honest metadata** — `news_sources.country` must be a real country the
   source publishes from; regional/global sources carry `country = NULL`
   + their region. `news_locations.country` is **ISO-2** (17,004 rows
   held Nominatim's full names — "United States", "Türkiye", "ایران" —
   so every cross-country comparison silently mismatched). A location
   row's label must match the place its **own articles** name
   (`news_articles.location_text`) — the gazetteer label alone is not
   proof: 6,368 rows were relabelled ("Belfast, GB" holding *London's*
   coordinates → "London Metropolitan Area, GB").

### Repair tooling

```bash
# audit + reset the "one source owns one capital" pileups
python3 -m worker.fix_source_pileups --dry-run
python3 -m worker.fix_source_pileups --fix-sources --apply   # country metadata
python3 -m worker.fix_source_pileups --apply                 # reset the piles

# normalise news_locations.country to ISO-2
python3 -m worker.normalize_location_countries --dry-run
python3 -m worker.normalize_location_countries --apply

# relabel / move mislabelled location rows (--merge is slow: it repoints
# ~220k news_articles rows — run it in a quiet window)
python3 -m worker.repair_locations --dry-run
python3 -m worker.repair_locations --apply
python3 -m worker.repair_locations --apply --merge

# rebuild the profiles the gate reads (no timer — manual)
python3 -m worker.source_profiles --all --days 30
```

> After changing the placement code, rebuild the profiles **and** restart
> the workers — a running cycle keeps the old code in memory:
> `sudo systemctl restart xyzo-fast-fetcher xyzo-fetcher`.

**Result:** Bamako 103 → **6** stories per 24 h window (real Mali news),
Podgorica 1,591 → **0**, Fargo 1,057 → **0**.

---

## API Uptime (2026-10-23)

The browser console filled with 502s on `/api/feed/live/stream` and
`/api/feed/links`. The chain had three links, all of which are fixed:

1. **`/api/pins/stats` was slow** (7–50 s: one full scan of the 2.5 M-row
   `news_articles` per call). It now uses range scans over a partial
   index (`api/migrations/2026-10-23-pins-stats-index.sql`) → **3 s cold,
   1 ms cached**.
2. **The api_watchdog treated it as a hung API** and restarted
   `xyzo-api` — **28 times in 6 hours**. Now only the *liveness* probes
   (`/api/health`, `/api/version`) may condemn the API; the heavy
   queries are measured and reported.
3. **Every restart was an 84-second outage** because the unit validates
   the API in `ExecStartPre=validate-api.sh --quick`, and `--quick` still
   ran the live-API timing sweep. `--quick` now skips it: **84 s → 0.9 s**,
   so a restart is ~2.5 s and Caddy's `lb_try_duration 20s` covers the
   gap → **no more 502s**.

| Symptom | Where to look |
|---|---|
| 502 on `/api/*` in the console | `journalctl -u xyzo-api` (restart?) and `logs/xyzo-api-watchdog.log` (why?) |
| The API restarts every couple of minutes | `logs/xyzo-api-watchdog.log` — a heavy probe must never be the trigger |
| `validate-api.sh --quick` takes minutes | it must skip the timing sweep (step 6) — that sweep is a deploy-time check, not a start-time one |

Two 400s were fixed along the way: `location-views` rejected every flush
with a **fractional** `zoom_level` (Leaflet can report 11.5) and
`image-proxy` answered 400 for a **dead host** (a missing image is a 404).

---

## What Xyzo Does

```
You open Xyzo
  → You see dots on a map
    → You click a dot
      → You see a story across 50 sources
        → You see its relationship tree: the same story elsewhere in the
          world, the basins and places it touches, the weakest links
        → You understand what happened, where, and who's involved
          → You can actually do something about it
```

**Real examples:**
- "There's a famine building in Madagascar that nobody's covering"
- "The same protest is happening in 12 countries at once"
- "Three startups just announced they hired the same person"

**Weather layers** (both from the free NOAA NCEP GFS analysis, both
opt-in in the layers dropdown):
- **💨 Wind (GFS)** — the 10 m wind as **moving streaks over the map**, with
  the speed in the colour. Four ways to draw it (**Streamlines**, the
  classic **Flow** texture of fibres, **Particles**, and static **Arrows**
  for a synoptic reading), two ways to colour it (**By speed** or a
  single **Mono** ink that reads over any basemap), and the site's own
  palette picker. A companion **🌬️ Wind speed (GFS)** wash underneath,
  with its own opacity, shows how fast the air is moving.
- **⛅ Pressure lines (isobars)** — the pressure contours every synoptic
  chart is built from, with the values labelled along each line. The
  detail under the layer's checkbox is selectable — **0.10 / 0.25 /
  0.5 / 1 / 2 / 4 / 8 / 16 hPa** — and 4 hPa (the classic synoptic
  chart) is the default. The published set is cut at **0.05 hPa** (the
  ladder's GCD), so every one of those steps is exact on one dataset.
  A second row right below it picks the **line colour**: **By pressure**
  (the published key), a single **Red / White / Black** ink for a
  basemap that swallows the lines, or the **Rainbow / Turbo** ramps —
  each chip carrying a dot of what it looks like. The lines are
  **continuous and smoothly rounded**: the contouring merges
  the raw pieces into whole isobars *before* rounding them, so a line
  is one unbroken curve rather than four fragments with a hard edge at
  each end. **All three settings are in the URL** — `overlay=isobars@90`
  says how opaque, `iso=4:red` says how detailed **and in what colour**
  — so a shared link reproduces the exact map, in the flat view and in
  the 3D globe. **The lines are audited against the field they were
  cut from** — the 0.25° GFS PRMSL (and the 0.1° ECMWF IFS message),
  on that source's own grid, with the worker's own blur. The audit's
  numbers are the honest ones: **p95 0.029 hPa** for GFS and
  **0.011 hPa** for ECMWF, against a gate of **0.4 hPa** — a tolerance
  calibrated from the measured contouring artefact (0.029–0.048 hPa
  over three cycles and the steepest terrain on Earth), not guessed.
- **🌡️ Temperature (GFS)** — a filled colour field of the near-surface
  air temperature, with a legend showing **°C and °F on the same bar**
  and a readout of the exact temperature under the cursor.

**Earth-science layers** (also opt-in in the layers dropdown):
- **🌐 Earthquakes (USGS)** — the last **1 hour / 24 hours / 7 days /
  30 days**, as four published catalogues refreshed every ten minutes by
  a timer (the browser never polls USGS). The circle's **radius grows
  with the magnitude** and its **colour cools with the age** — red under
  an hour, orange under a day, yellow under a week, blue under a month —
  and the popup carries the magnitude, the place, the time in UTC *and*
  local, the depth, the felt reports and the tsunami flag, with an
  **"Open ↗"** link to the USGS event page.
- **🪨 Tectonic faults (USGS)** — the **33,926** fault traces of the
  USGS Quaternary Fault and Fold Database plus the global plate
  boundaries, drawn as lines and coloured by kind and by the age of the
  movement, with the most significant faults first so a world view is
  not a hairball.
- **🌊 Ocean currents (OSCAR)** — the surface-current field itself, as an
  **animation**: particles advect along the published OSCAR u/v grid, so
  you can see the Gulf Stream run north and the Antarctic Circumpolar
  Current circle the globe. The trail is trimmed by **length**, never by
  a frame count, and the particles are seeded from the grid's **wet
  cells** — so the field is visible over the whole ocean, not just
  where a random screen pixel happened to be moving.
- **🌍 Language regions** — where the world's languages are, as
  **regions** rather than dots: **234** territories, each carrying the
  languages spoken there and how many. Papua New Guinea reads as 928
  languages, the Pacific as one. The original point layer (8,889
  Glottolog coordinates) is still there beside it, because "where is a
  language spoken" and "which languages are in this region" are
  different questions.
- **🪨 Geology (Macrostrat)** — colourful bedrock units from the
  Macrostrat carto tiles (hotlinked, real polygons through z14), plus
  an optional **🗺️ Geologic contacts** overlay that draws the USGS/GSC
  fault-and-contact line network in white on the dark basemap. A probe
  reads the unit under the cursor (name, age range, lithology) from
  Macrostrat's point API.
- **🧭 Magnetic Field (WMM)** — **D, F, H, I × (main field | change per
  year) = eight selectable fields** from the NOAA/BGS World Magnetic Model
  2025: declination, total force, horizontal force and inclination, each
  with its own contour family (isogonics / isodynamics / isohorizontals /
  isoclinics, plus the isoporic rate lines), colour wash, ramp and probe
  value. Two chip rows in the legend pick the component and the value;
  the agonic, aclinic and no-change lines are emphasised. Index contours
  every 10° / 5,000 nT / 1 °/yr are labelled, thin intermediates fill in
  between and appear from zoom 4. The probe reads all four of the active
  mode together (`D 12°34′E · F 50,120 nT · H 31,400 nT · I 63°12′↓`), and
  the blackout zones where a *compass* is unreliable are blanked — but only
  for D and ΔD, because F is strongest and H merely small there. Signed
  fields get a diverging **violet → azure → cyan (zero) → gold → crimson**
  ramp — no green anywhere, and zero still glows — while the magnitudes
  get a sequential **indigo → violet → rose → amber** ramp, because they
  have no meaningful zero to glow. A static model — rebuilt when a new WMM
  ships every ~5 years, not on a timer.
- **🌊 Wave height & power** — the global sea-state field from NOAA
  NCEP GFS Wave (gfswave 0.25°, free, no key), baked by
  `worker/wavemap.py` into two Int16 grids (height + period). The legend
  carries a **Height | Power** switcher: power is derived client-side
  as `P ≈ 0.44·Hs²·Tp` from the same constants the worker publishes.
  Probe reads metres, seconds and kW/m together.
- **🤝 Facebook Friendships** — ten million Facebook friendship pairs
  plotted globally (NOAA SOS Explorer). The alpha IS the density, so the
  basemap shows through where nobody is and the arcs glow where people
  are: Europe and the US blaze, the Sahara and the ocean go dark, and
  China reads dim because of domestic platforms and restrictions.
- **🌊 Hydrological Basins** — the FAO "major hydrological basins of the
  world" drainage regions (HydroSHEDS / Hydro1K), 235 named basins. A
  translucent wash with the basin boundaries, and a probe that reads the
  basin under the cursor with its area (`Amazon Basin · 5,994,109 km²`).
  The basins are coloured by hydrological character — river basin,
  coastal/oceanic drainage, or an interior (endorheic) basin.
  **FOUR DETAIL LEVELS: two populations, two precisions each**, as one
  chip row in the legend, so *how much detail* and *which basins* are
  the same control:

  | level | population | tolerance | file |
  |---|---|---|---|
  | `major` | 235 named basins | 0.05° | 6.1 MB |
  | `detailed` | 235 named basins | 0.01° ≈ 1.1 km | 12.8 MB |
  | **`internal`** | **281 endorheic** | 0.05° | 0.3 MB |
  | **`internal-detailed`** | **281 endorheic** | 0.01° | 1.6 MB |

  **THE INTERNAL POPULATION IS THE PUBLISHER'S OWN DEFINITION.** The
  2012 source has no hydrology column at all, so the major levels read
  `kind` off the basin's NAME (`"Interior"` → endorheic) and can only
  ever find the **8** regions FAO named that way. The 2022 source
  carries `TO_BAS`, the downstream basin code, where **`-888` means an
  internally drained sub-basin** — 281 of them, each named and measured
  (Sahara, Borkou, Aral Sea, Lake Balkash, Ch'ing-hai Hu, Lop Nur,
  Gobi, Great Salt Lake, Lake Frome, the Makgadikgadi pans …).
  **`kind` is set by the filter, not guessed**: every feature in an
  internal level is `interior`, and `verify()` fails the build if one
  is not.

  **LEAFLET SIMPLIFIES EVERY POLYGON IT DRAWS** — a tolerance of
  `smoothFactor` PIXELS, default 1.0 — and it reads that option when
  the polygon is CREATED, so the client used to throw **98.7 %** of
  the detailed file away (689,947 vertices in the file, 9,207 on the
  screen) and **the two levels rendered byte-for-byte identically**.
  The fine levels now use `smoothFactor: 0` so the published precision
  is what the reader sees (**65,782 drawn vertices, 5.2× the path
  length, individual basins 2.4×–10.6× sharper**; the internal pair
  measures **1,933 → 19,170** drawn vertices, 9.9×); the coarse levels
  keep Leaflet's default so the fast map stays fast. **The factor is
  read from the level's own `simplify_deg` in meta.json, NOT matched
  on the level id** — `state.level === "detailed"` gave the wrong
  answer for `internal-detailed` and would have shipped that level as
  the exact no-op the rule exists to prevent. **It has to be set on
  the layer AND on every feature, and `setLevel()` must change it
  BEFORE the layer is rebuilt** — `setStyle` does not re-simplify, so
  a switch that only swapped the data would keep the old tolerance.

  **THE LEGEND DESCRIBES THE LEVEL ON SCREEN**: the active level's own
  count (`281 FAO basins`) and only the kinds that level actually has
  (`Interior (endorheic) basin (281)` — one row), rather than the
  top-level `basin_count` and all three kinds whatever was selected.
- **🛰️ Human Transportation** — NOAA's "Anthropocene" composite: the
  Black Marble 2012 night-lights base with **red** lines for 87,000
  daily flights, **blue** for3,500 commercial vessels tracked over a
  year (~10 % of global shipping), and **green** for the world road
  network. One frozen equirectangular PNG (2048×1024, 522 KB) painted
  through a wrapping `L.GridLayer`, so it pans past the antimeridian
  without a gap — a plain `imageOverlay` would leave a hole. Static
  asset, no cycle.
- **🧂 Sea surface salinity** — NOAA GFDL's CM2.6 model of how salty
  the ocean surface is (PSU — grams of salt per kg of water): the
  salty subtropical gyres burn red, the fresh Arctic and river plumes
  run blue. Frame 0 of NOAA SOS's 1,094-day animation, land masked to
  transparency so the basemap's continents show through, painted by
  the same wrapping `L.GridLayer` as transportation.
- **🌊 Ocean Currents (ECCO)** — NASA's ECCO-2 model of sea-surface
  currents, coloured by water temperature (~32 °F / 0 °C blue up to
  ~77 °F / 25 °C red). The Gulf Stream, Agulhas rings, Kuroshio and
  Antarctic Circumpolar Current read as bright warm ribbons against the
  navy ocean. Extracted from NOAA SOS's 120 s animation as a single
  frame, with land cut to transparency, polar sea-ice blanked, the
  burned-in player chrome patched out and warm current cores
  selectively saturated — painted by the same wrapping `L.GridLayer`.

**Three more views of the same world:**
- **🛰️ Satellite anywhere** — one lone click on empty map (wait for
  the hint chip to morph) opens a live Esri satellite mini-map of that
  exact spot, with one-click jumps out to **Google Satellite** and
  **Bing Aerial** for the deep zoom. Right-click is never hijacked —
  the browser's own menu (Inspect and all) stays put everywhere.
- **🧭 The story tree** — clicking a pin opens a ranked relationship
  tree: the same story carried by other outlets, then the related
  stories from most to least. See `docs/STORY_TREE_2026-10-27.md`.
- **🌐 A 3D globe** — `/globe` renders the same overlays and the same
  2,000 story pins on a real sphere (MapLibre GL). The flat map is
  Leaflet and stays Leaflet; the globe is a separate view, and a pin
  clicked on either one links to the other. A shared globe link carries
  the whole view: `#lat,lng,zoom/overlay=koppen@50,soil@55/proj=globe`. Every flat-map overlay that
  MapLibre can render is there: climate, soil (with the full property
  switcher), cropland, land cover, geology, NASA satellite/rain/night,
  rivers, hydrological basins, the magnetic field (contour family + colour
  wash, with its own component/value switcher and one opacity slider),
  isobars and temperature, the **wind animation** and the **wind speed
  field**, the **live ocean currents**, the **earthquakes**, the
  **tectonic faults** and the **language regions** — 21 overlays in all.
  Geologic contacts (a WMS layer), the transport and salinity pictures,
  the relief, the wave/CAPE/IVT fields, the phytoplankton, the language
  points, the city names and the population density stay on the flat
  map; each one is listed with its reason in
  `public_html/tests/panel-parity.bun.test.js`.

---

## Data Quality & Provenance — what the map is built on

**Every overlay on Xyzo is derived from a verifiable scientific source,
never from uncurated or potentially wrong data.** The principle is
simple: if the data cannot be checked against a published dataset with a
known licence and a known update cycle, it does not go on the map.

| Overlay | Source | Licence | Verified by |
|---|---|---|---|
| ⛅ Isobars | **NOAA NCEP GFS `PRMSL` (0.25°)** — and, **selectable by the reader since 2026-11-04**, **ECMWF IFS (0.1°)** or **NOAA HRRR (3 km)** | GFS + HRRR: public domain. **ECMWF IFS: CC BY 4.0 — attribution required** (named in the map's attribution bar) | `worker/gfs_verify.py::isobar_check()` — re-decodes the raw GRIB and checks each published line against it (isobars.py has no `verify()` of its own; this row used to claim it did). **The field is re-read on the SOURCE'S OWN GRID** — the GFS lines are cut from the 0.25° PRMSL, so the check reads the 0.25° message, not the 1° one (reading the 1° field made the audit report a **1.35 hPa** false alarm against lines that are accurate to **0.03 hPa**). Published at a **0.05 hPa lattice** since 11-06 — the finest set the
ladder's GCD needs, so `step=0.1` really does draw a line every 0.10 hPa
(the API thins it to 0.1 / 0.25 / 0.5 / 1 / 2 / 4 / 8 / 16) — same source,
same licence, same gate, whose tolerances are **0.4 / 0.25 / 0.6** again
(re-measured at the new lattice: GFS p95 0.032 hPa, ECMWF 0.010). **The analysis is now the reader's choice** (⚙ → layers → ⛅ → **Auto · ECMWF · GFS · HRRR**), and it travels with the link (`/isoSrc=ecmwf`) |
| 🌡️ Temperature (GFS) | NOAA NCEP GFS `TMP` 2 m | Public domain | `worker/tempmap.py::verify()` — equator must beat poles by 30 °C. **Published at 0.25° since 2026-11-04** (it was 1°, which made it the odd one out beside the 0.25° isobars; the same cycle at 1° and at 0.25° agrees to a median of 0.0 °C and is at worst **2.4 °C** out). The globe reads the 1° copy — the same field, subsampled by the same run. |
| 💨 Wind (GFS) | NOAA NCEP GFS `UGRD`/`VGRD` 10 m | Public domain | `worker/wind_verify.py` — geostrophic balance vs pressure, plus a cell-by-cell comparison with the raw GRIB. **Published at 0.25° since 2026-11-04** (it was 1°, and the 1° grid was **78° wrong at Nairobi** — the same cycle at 1° and at 0.25° agrees exactly at nineteen of twenty-four points and not at the two where the flow has structure finer than a degree). The globe reads the 1° copy — the same field, subsampled by the same run. |
| 🌊 Wave height | NOAA NCEP GFS Wave 0.25° | Public domain | `worker/wavemap.py` — height/period sanity bounds |
| 🌍 Köppen climate | Beck et al. 2018 (1 km) | CC BY 4.0 | `scripts/koppen_build.py::verify()` — 11 known-place probes, plate carrée + Mercator |
| 🟫 Soil (SoilGrids) | ISRIC SoilGrids 2.0 | CC BY 4.0 | `scripts/soil_build.py::verify()` — Sahara is sand, Amazon is clay |
| 🟫 Soil — USDA orders chip | OpenLandMap-soildb (OpenGeoHub), 12 orders of the USDA Soil Taxonomy at 30 m | CC BY 4.0 | `scripts/soil_build.py::verify_usda()` — Kansas is Mollisols, the Deccan is Vertisols, Siberia is Gelisols (6/6 against the live COG); the class table is pinned against the publisher's own SLD by `hwsd`-style source assertions in `soil-layer.bun.test.js` |
| 🟫 Soil type (HWSD v2.2) | FAO & IIASA Harmonized World Soil Database v2.2 (~1 km, 30 arc-second, 34 WRB groups) | CC BY 4.0 | Hotlinked WMTS (no local copy to gate) — but the 34-class table is pinned against the service's own `GetLegendGraphic` by `hwsd-layer.bun.test.js`, and the probe reports "unknown colour" instead of guessing when a pixel matches no published swatch |
| 🌾 Cropland (ESA) | ESA WorldCover 10 m | CC BY 4.0 | `scripts/cropland_build.py::verify()` — North China Plain, US corn belt |
| 🪨 Geology | Macrostrat carto tiles | CC BY 4.0 | Hotlinked polygons, probe reads unit/age/lithology |
| 🧭 Magnetic field | NOAA/BGS WMM2025 | Public domain | `worker/magmap.py::verify()` — NOAA's own ~100 published test points across **D, I, X/Y/Z, F, H and all four annual rates** (D/I to 0.005°, F/H to 0.0007 nT), plus the relationship gates: F ≥ H ≥ 0, F ≥ \|Z\|, the ramp brackets every cell the wash paints, and no plane overflows Int16 |
| 🌊 Hydrological basins | **FAO (HydroSHEDS / Hydro1K) — two sources:** the 2012 "Major hydrological basins of the world" (235 named basins) and the 2022 "Hydrological basins of the world" (**281 internally drained sub-basins**, `TO_BAS = -888` — a column only the 2022 file has) | CC BY-SA 4.0 (both) | `scripts/basin_build.py::verify()` — **per level**: major/detailed get **15** place probes and a 40–200 M km² total; internal/internal-detailed get **14** (Sahara, Aral, Balkhash, Dasht-e Kavir, Qinghai, Turpan, Lop Nur, Gobi, Great Salt Lake, Lake Frome, Borkou, Kyzylkum, Omuramba Ovambo, Egyptian desert) and a 14–26 M km² total, plus an **every-feature-is-`interior`** check so a failed `TO_BAS` filter cannot publish a mixed population under a name that promises one |
| 🌊 **Rivers (FAO 2026)** | **FAO AQUASTAT — "Rivers (Global, edition 2026)", from HydroRIVERS (HydroSHEDS)** — every river reach on Earth with a catchment of 10 km² or an average flow of 0.1 m³/s. **The lines are rendered from our OWN copy of the network below z4** (the whole edition — 8,477,883 reaches — was paged out of the publisher's WFS and rendered into a static PNG pyramid; see `scripts/river_network_fetch.py` and `scripts/river_tiles_build.py`), and above z4 they come from the publisher's own WMS (`data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wms`, layer `river_network`) through our caching proxy — the network is more than a million reaches and cannot be shipped as data | **CC BY 4.0** (attribution required — it is printed in the map's attribution bar) | `scripts/river_network_build.py::verify()` — the **six great rivers are probed against the SOURCE geometry** (the Amazon within 0.08°, the Nile 0.03°, the Congo 0.03°, the Yangtze 0.10°, the Danube 0.11°, the Mississippi 0.04°), the **four detail levels must draw four DIFFERENT pictures** (measured 38 KB / 73 KB / 144 KB / 226 KB over the lower Amazon), and the **published style's gap is confirmed every build**: a GetMap for the reaches of order 7 and finer comes back with **zero opaque pixels** under the publisher's own style, while our SLD draws them |
| 🤝 Facebook friendships | NOAA SOS Explorer | Public domain | `scripts/facebook_build.py::verify()` — source + tile gates, 13 probes |
| 🌍 Languages | Glottolog (MPI) | CC BY-SA 4.0 | `scripts/languages_build.py::verify()` — 6 known languages in known places |
| 🧂 Sea salinity | NOAA GFDL CM2.6 | Public domain | Land masked to transparency, frame 0 of the published animation |
| 🌊 Ocean currents | NASA ECCO-2 via NOAA SOS | Public domain | Land cut, polar ice blanked, player chrome patched out |
| ⚡ **Lightning density** | WWLLN Global Lightning Climatology (Zenodo), 5 arc-min, 2020-2022 | **CC BY 4.0** | `scripts/lightning_build.py::verify()` — 22 checks: 77% of density in the tropics, poles <1%, Sahara vs Congo, ten hotspots, longitude not mirrored, July northern / December southern |
| 🌐 **Earthquakes** | USGS Earthquake Hazards Program — ComCat GeoJSON summary feeds | **Public domain** (US Government work) | `scripts/earthquake_build.py::verify()` — the newest event is inside the hour window, the month feed holds more than the hour feed, the coordinates are not swapped (**the eleven `PLACE_PROBES`: known places in known boxes, each firing above a 5 % outside rate**; Chile's box was corrected 2026-11-14 to **-56..-17 lat, -70 ±35 lon** because the matcher is by *name* and USGS tags the offshore "West Chile Rise" events as Chile — a wrong box, not a loosened tolerance, and a swapped or mirrored coordinate still puts 100 % of them outside), every event carries a magnitude |
| 🪨 **Tectonic faults** | USGS Quaternary Fault and Fold Database + USGS global plate boundaries (KML) | **Public domain** (US Government work) | `scripts/faults_build.py::verify()` — the San Andreas, the Hayward and the plate boundaries land in their known places, and the coordinate order is not swapped |
| 🌊 **Ocean currents (OSCAR)** | OSCAR Sea Surface Velocity (ESR / NASA PO.DAAC), 1/3° → 1° | **Public domain** (US Government work) | `scripts/ocean_currents_build.py::verify()` — the South Equatorial Current flows west, the Gulf Stream leaves the Florida Straits northward, the ACC is fast and eastward round the globe, the Sahara and central Asia carry no current, the axes are not swapped, **the Gulf of Guinea still carries a current (44.6 % — the altimetry mask leaves the shallow Bight of Benin empty, which is the SOURCE and not this build)**, and **the composite is FRESH (≤ 45 days)**. **Re-run against the published grid on 2026-11-04**: the nine physics checks pass, the coastal coverage is 0.4462, and the **freshness gate FAILS — the newest composite the ERDDAP mirror carries is 2014-09-26, 4,422 days old**, so the build refuses to publish it and the daily timer alarms until a fresh source is configured (Known Issue Q-N1). The layer's **name** says the source and its **legend** shows the composite's own date and age; the URL slug is still `ocean-currents-live` |
| 🌍 **Language regions** | Glottolog (MPI) territories × Natural Earth 50 m admin-0 | **CC BY-SA 4.0** (Glottolog) + **Public domain** (Natural Earth) | `scripts/languages_regions_build.py::verify()` — known languages land in their known region, the representative point is inside its own polygon, the axes are not swapped |
| 🛰️ **NASA overlays** (rain rate / true-colour satellite / night lights) | NASA GIBS — GPM IMERG, VIIRS SNPP corrected reflectance, VIIRS Black Marble | **Public domain** (US Government work) | `api/src/routes/tileProxy.ts` — the proxy probes a **canary tile** (a fixed one over central Africa, covered by every one of these products) to find the most recent **PUBLISHED** date, because GIBS publishes the true-colour satellite a day or two behind and "yesterday" was a whole layer of 404s; it retries a 404 before believing it (GIBS's CDN is flaky — the same URL answered 404, 200, 200, 404 in four identical requests), and it answers a **missing** tile with a transparent PNG so the browser logs nothing |
| 🦠 **Phytoplankton** | MIT Darwin Project / MITgcm / ECCO-2, 1994-1999 | **MIT Licence** | `scripts/phytoplankton_build.py::verify()` — 31 checks: ocean modelled and land **not**, all four types, Southern Ocean diatom-dominated, gyres at low biomass, large species carry more phosphorus |

**The `verify()` gates are not decoration.** Each builder refuses to
publish if a probe fails — a flipped axis, a broken density channel or a
degrees/radians slip still produces a *picture* that looks like a map,
and only known places catch it. They are run on every rebuild.

**What is deliberately NOT on the map:** anything that would need
uncurated, self-reported, or licence-ambiguous data. The IUCN Red List
vertebrate ranges are the clearest example — the data itself is free to
*view and query* but its terms of use forbid redistribution, so it cannot
be baked into tiles we serve. (See the species-map plan below.)

### Planned: a species / biodiversity layer

A species map is a priority. The constraint is data provenance: it must
come from a source we can actually verify and redistribute. Two viable
paths, in order of licence safety:

1. **GBIF (CC0 / public domain)** — 3.7 billion species occurrence
   records, no commercial restriction, no redistribution restriction,
   no attribution required. The live density-tile API is too slow to
   call per-request from this host, so the plan is a **build-time tile
   pyramid** fetched once by a script (the same pattern as the other
   raster overlays).
2. **Our own news-derived layer** — species and conservation stories
   extracted from the 2.9 M articles we already ingest, using the
   existing NER + entity pipeline plus a free species lexicon (ITIS /
   Catalogue of Life, both CC0). This maps *where the world is talking
   about species*, which is different from where species live — but it
   is ours, it is live, and it cannot be wrong about a licence.

The IUCN Red List itself is the reference design to study, not the data
to copy: their terms of use (v3.1, June 2024) list **"No Commercial
Use"** and **"No Reposting and/or Redistribution"**, so neither the
shapefiles nor the API output can be baked into tiles we serve.

---

## Wildlife Source Network (2026-10-29)

The map had **one** conservation outlet (Mongabay) and **zero** wildlife
agencies. The registry now covers **443 candidate organisations** and
**101 live, probed feeds** were added to `news_sources`.

### The rule: a feed is probed before it is written

A homepage that answers 200 proves nothing about the feed. Half the
conservation orgs in the world publish a site whose feed was moved, sits
behind a bot wall, or parses cleanly but has been empty for two years.
Ingesting an unprobed feed produces a row that looks healthy in the admin
panel and never yields an article — which is exactly what the dormant
`Smithsonian Magazine`, `National Geographic` and `Yale Environment 360`
rows already were.

`worker/wildlife_sources.py` therefore refuses to import anything it has
not seen work:

| Step | What it does | Why |
|---|---|---|
| 1 | Try every candidate feed URL in the registry | the publisher's own declaration |
| 2 | Fetch the homepage, read `<link rel="alternate" type="application/rss+xml">` | publishers who declare their feed properly |
| 3 | Scan the homepage for any feed-ish href | publishers link the feed from a nav item, not a head tag |
| 4 | Try the common conventions (`/feed/`, `/rss/`, `/feed.xml`, `?feed=rss2`, `/atom.xml`, …) | WordPress / Drupal defaults |
| 5 | Parse with `feedparser` and require **≥ 1 entry** | a feed that parses but is empty is EMPTY, not WORKING |
| 6 | Consult `robots.txt` for the winning URL | a disallowed feed is never imported |
| 7 | Reject comment feeds and podcast enclosure feeds | they parse cleanly and carry no news |

### The numbers

| | |
|---|---|
| Candidates in the registry | **443** |
| Feeds that probed clean | 128 |
| Importable (after the alias rule) | 119 |
| **New sources written** | **101** (7 more were already in the DB) |
| Duplicate feed URLs dropped | 9 (8 regional BirdLife editions all resolve to `birdlife.org/feed/`; `news_sources.feed_url` is UNIQUE, so the extras would have silently vanished) |
| Comment / podcast feeds rejected | 2 (Forest Trends' `/comments/feed/`, European Wilderness Society's `/feed/podcast`) |
| Aliases collapsed | 4 (`snowleopard.org` **is** the Snow Leopard Trust; the non-www Hakai feed and the WOAH `/en/feed/` carry the same documents as their siblings) |
| Robots-blocked | 3 (New Scientist, France 24, Icelandic Environment Agency) |
| Candidates with **no** working feed | 312 — of which 109 are hostnames that do not resolve and 48 are Cloudflare-protected |
| Found by discovery, not by guess | **24** (17 by the URL convention, 6 by the `<link>` tag, 1 by the page scan) |

The registry keeps every candidate, including the failures, with a
derived `skip` flag and the reason — a source with no feed today may
have one tomorrow, and the record of *why* it failed is worth more than a
silently deleted row. The skip flags are **derived from the probe
report**, never hand-maintained, so the registry can never claim a source
works when it does not.

### Where the sources live

| | |
|---|---|
| Registry | `worker/data/wildlife_sources.json` — 443 entries, each with country, language, region, scope, topics, candidate feeds |
| Probe report | `logs/wildlife_sources_report.json` — one row per candidate with the verdict, the HTTP status, how the feed was found, and the URLs tried |
| Tool | `worker/wildlife_sources.py` — `validate`, `import`, `report` |

```bash
python3 -m worker.wildlife_sources validate      # probe every candidate (≈5 min)
python3 -m worker.wildlife_sources validate --retry-failed   # deep re-probe of the failures
python3 -m worker.wildlife_sources import --write-skips      # dry run + write derived skip flags
python3 -m worker.wildlife_sources import --apply           # write to news_sources + feeds.json
```

Both stores are written: `news_sources` (what the fetcher reads,
`worker/fetch.py::CLAIM_SQL`) **and** `worker/feeds.json` (what
`worker/check_feeds.py` audits). The fleet already carries a 1,873-row
drift between them; this change adds none.

**The seed path had to be fixed too.** `worker.run --seed-feeds` upserts
`country`/`region` from `feeds.json`, and three entries there carry
`country: ""` and `region: "unknown"` — so one seed run blanked the real
country of New Scientist ('GB'), ScienceDaily ('US') and JESUS NEWS
('KR') and the placement gate then rejected them. `seed_sources()` now
uses `COALESCE(NULLIF(EXCLUDED.country, ''), news_sources.country)` and
keeps a real region over `'unknown'`: **the seed path is a fill-in,
never a downgrade**. Pinned by
`worker/tests/test_wildlife_sources.py::test_the_seed_path_cannot_degrade_a_country`.

### The placement rules that came with it

`news_sources.country` must be a real country the publisher publishes
from, and it must not be invented:

- **Multi-country outlets carry `country = NULL`** and a coverage role in
  `locality` — Mongabay, WWF, IUCN, CITES, CMS, TRAFFIC, Oceana, Wetlands
  International. A country here would let the single-city source fallback
  pin every story to one capital (the Bamako pileup, see **"Placement
  Integrity"**). The first import gave 36 of them a country and the
  fallback duly put African conservation stories on a US city and global
  science stories on London; all 36 were cleared and their 593
  mis-placed articles re-opened for placement from their own text.
- **National bodies keep their country** and `locality='national'` — that
  is what makes the placement gate work (Estonian Environmental Board →
  Estonia, Sri Lanka's Department of Wildlife Conservation → Sri Lanka).
- **Regional desks carry their editorial base**, each checked against the
  publisher's own site, not guessed: Snow Leopard Trust → `US` (**Seattle**
  HQ — it is a US 501(c)(3) with partners in Mongolia, India, Kyrgyzstan,
  China and Pakistan), Eurobats → `DE` (UNEP, Bonn), African Conservation
  Foundation → `GB` (**UK registered charity 1120705**).
- **General news feeds are NOT tagged `wildlife`.** BBC Science &
  Environment, PBS NewsHour, Euronews Green and Phys.org are tagged
  `topic='science'` or `topic='environment'` — claiming a general feed
  is a wildlife feed would make any wildlife filter on the map lie.

Each imported row also carries `topics TEXT[]` (the multi-axis taxonomy),
`science_focus` / `science_subfocus`, `locality`, `paywall` and
`free_access`. **6** of the 101 are paywalled (NYT Climate, Scientific
American, Nature, the science journals) — headline, date, URL and
source id only, never the body.

### Licences

News feeds are **linked, never republished**. The registry stores the
headline, publication date, original URL, source id and the publisher's
own summary; no article body and no image is copied. Each publisher's
`robots.txt` was consulted before the feed was enabled, and the
`free_access` / `paywall` flags record what a reader actually gets.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  RSS / Audio   │ ──▶ │  Python Worker  │ ──▶ │  PostgreSQL     │
│  / Video Feeds │     │  Fetch + Extract│     │  + PostGIS      │
└─────────────────┘     └─────────────────┘     └──────────────────┘
                                                          │
                        ┌─────────────────┐               │
                        │  Bun + Hono API │ ◀──────────────┘
                        │  :3008          │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                         │  Your Browser   │
                         │  160+ countries │
                         │  on one map    │
                        └─────────────────┘
```

| Layer | Tech | Purpose |
|-------|------|---------|
| Database | PostgreSQL + PostGIS | Geographic queries, JSONB flexibility |
| Workers | Python | Fetch, NLP, geocode, cluster |
| AI | Gemma 4 (local) | Reasoning with constraints |
| API | Bun + Hono | Fast, lightweight, TypeScript |
| Frontend | Vanilla JS + Leaflet | No build step, 20 languages |

**Philosophy:** Don't use a neural network where SQL suffices. Use the simplest tool that works.

---

## Project Structure

```
xyzo/
├── api/                    # Bun + Hono API server
│   └── src/routes/        # ~46 route files (see api/src/routes/README.md)
│       ├── news.ts        # News submission queue + article recommendations
│       ├── imageProxy.ts  # Publisher images: a dead picture answers a 1×1 PNG
│       └── tileProxy.ts   # NASA GIBS tiles: a missing tile answers a 1×1 PNG
├── worker/                # Python workers (~170 modules)
│   ├── run.py             # Pipeline entry (full / --fast)
│   ├── fetch.py           # RSS/JSON feed fetching (5-min lease system, batch claims)
│   ├── web_scraper.py     # HTML scraping for 'web'-type sources (bounded 8MB)
│   ├── robots.py          # robots.txt cache + compliance
│   ├── extract.py         # AI content extraction (Gemma 4)
│   ├── auto_categorize.py # Fast-path city/category assignment + source fallback (gated)
│   ├── place_disambiguation.py # Watchlist disambiguation (Virginia ≠ ZA, etc.)
│   ├── geocode.py         # Place name → coordinates (Nominatim)
│   ├── density.py         # Cluster sanity checks / auto-correct
│   ├── wiki_geo.py        # Wikipedia gazetteer resolution
│   ├── source_profiles.py # Per-source geographic profiles (news_source_geography)
│   ├── cluster.py         # Group articles into events
│   ├── city_coolness.py   # Coolness leaderboard
│   ├── validate_cities.py # Coordinate-vs-country validation (Natural Earth)
│   ├── fix_source_pileups.py   # Audit/reset "one source owns one capital" pileups
│   ├── normalize_location_countries.py # news_locations.country → ISO-2
│   ├── repair_locations.py     # Relabel / merge duplicate location rows
│   ├── api_watchdog.py         # API liveness watchdog (*/2 cron)
│   ├── health_monitor.py  # Lease cleanup / crash recovery / CPU load guard
│   ├── pin_moderate.py    # Stage-2 deep moderation of community submissions
│   ├── timer_watchdog.py  # Service liveness monitor (--fix via cron)
│   ├── nn_*.py            # Neural-net phases (embed/geo/match/rank/coverage/relate)
│   ├── xyzo_debug/        # Playwright/DevTools diagnostics CLI
│   └── tests/             # Worker tests (pytest)
├── public_html/           # Frontend (no build step!)
│   ├── app.js             # Main app (canvas pin renderer merged in)
│   ├── index.html         # Entry point
│   ├── styles.css         # Styles
│   ├── city-engine.js     # Client-side city search (lazy dataset)
│   ├── console-guard.js   # XLog + console suppression (loads FIRST)
│   ├── climate-layer.js   # Köppen climate overlay (tiles + class key + probe)
│   ├── isobar-layer.js    # Pressure contours (isobars) from the GFS analysis
│   ├── temp-layer.js      # Temperature colour field (GFS 2 m) + °F/°C legend
│   ├── wind-layer.js      # Wind streamlines (GFS 10 m) on an animated canvas
│   ├── soil-layer.js      # Soil overlay: WRB groups + texture + SoilGrids props
│   ├── cropland-layer.js  # Cropland + land-cover overlays (ESA WorldCover)
│   ├── river-layer.js     # Natural Earth rivers (rank-styled GeoJSON)
│   ├── basin-layer.js     # FAO hydrological basins (dissolved GeoJSON + probe)
│   ├── data/facebook/     # Facebook friendships tile pyramid (built)
│   ├── geology-layer.js   # Macrostrat bedrock + USGS/GSC contacts (hotlinked)
│   ├── city-labels.js     # City-name labels (population-filtered canvas)
│   ├── etopo-layer.js     # Relief overlay (ETOPO 2022 bathymetry + topography)
│   ├── wave-layer.js      # Wave height & power (NOAA GFS Wave, derived P)
│   ├── mag-layer.js       # Magnetic field (WMM2025): D/F/H/I × main|rate = 8 fields, selector + wash + probe
│   ├── transport-layer.js # NOAA "Anthropocene" composite (lights + flights/roads/shipping)
│   ├── salinity-layer.js  # NOAA GFDL CM2.6 sea-surface salinity (PSU) wash
│   ├── ocean-layer.js     # NASA ECCO-2 ocean currents coloured by temperature
│   ├── ocean-current-layer.js # OSCAR ocean currents (u/v, animated particles)
│   ├── earthquake-layer.js # USGS earthquakes: 1 h / 24 h / 7 d / 30 d, sized + aged
│   ├── fault-layer.js     # USGS tectonic faults + plate boundaries (GeoJSON lines)
│   ├── languages-regions-layer.js # Glottolog territories × Natural Earth (234 regions)
│   ├── tour.js            # The guided first visit (six steps; ⚙ → How to)
│   ├── globe.html         # 3D globe view (MapLibre) — same overlays, same pins
│   ├── globe.js           # Globe: projection switch, overlays, pin layer
│   ├── globe.css          # Globe styles
│   ├── isobar-debug.html  # Bare isobar geometry, for judging line quality
│   ├── overlay-opacity.js # Per-overlay opacity sliders in the layers dropdown
│   ├── digest-panel.js    # The "Today" digest panel
│   ├── vendor/            # Vendored libs (leaflet, maplibre-gl, dompurify, …)
│   └── tests/             # Bun tests (*.bun.test.js) + browser tests (*.test.js)
├── systemd/               # Service/timer unit files
├── scripts/               # Utility scripts (validate-api.sh, api-health-check.js,
│                           #   bump_frontend.sh, koppen_build.py,
│                           #   soil_build.py, cropland_build.py, river_build.py,
│                           #   basin_build.py, earthquake_build.py,
│                           #   faults_build.py, ocean_currents_build.py,
│                           #   languages_regions_build.py, …)
│                           # Playwright audits: tour_audit.py, ocean_current_audit.py,
│                           #   image_proxy_audit.py, hover_audit.py, globe_wind_audit.py,
│                           #   offline_notice_audit.py, globe_audit.py
├── docs/                  # Architecture & design docs
├── geoip/                 # GeoIP data
├── collab/                # Collaborator install tooling
└── tests/                 # Test infrastructure (run_tests.sh)
```

> The operational runbook — deployment, robots verification, city validation,
> NER backfills, debug CLI, env vars — lives in **`AGENTS.md`**.

---

## Common Tasks

### Running the Pipeline

```bash
# Full pipeline (fetch → extract → geocode → cluster)
python3 -m worker.run

# Fast mode (fetch only, no AI)
python3 -m worker.run --fast

# Single source test
python3 -m worker.fetch --limit 1
```

### Adding a News Source

> ⚠️ **Security note (2026-09-26 audit):** `POST /api/sources/add` and `/api/sources/bulk-add` are
> currently **public** (rate-limit only) — this is a tracked critical issue (FIX_NOTES §2.2/§2.3,
> second-order SSRF into the root-run fetcher). Until it's auth-gated, only use them for URLs you
> trust. The admin-gated equivalent is `POST /api/add-source` (requires super-admin key).

```bash
# Via API (easiest)
curl -X POST http://localhost:3008/api/add-source \
  -H "Content-Type: application/json" \
  -d '{"name":"My News","feed_url":"https://example.com/rss","country":"US"}'

# Bulk add sources
curl -X POST http://localhost:3008/api/sources/bulk-add \
  -H "Content-Type: application/json" \
  -d '{"sources":[{"name":"News","feed_url":"https://...","country":"US"}]}'
```

**A wildlife / conservation / biodiversity source goes through the
registry instead** — `worker/data/wildlife_sources.json` plus the probe
tool, so robots.txt, the feed's non-emptiness and the country metadata
are checked before the row lands:

```bash
# add the entry to worker/data/wildlife_sources.json, then:
python3 -m worker.wildlife_sources validate     # probe it
python3 -m worker.wildlife_sources import --write-skips
python3 -m worker.wildlife_sources import --apply
```

See **"Wildlife Source Network"** above.

### Finding News in a City

Use the **Explore** panel in the UI, or the API:

```bash
# Discover sources for a region
curl -X POST http://localhost:3008/api/explore-region \
  -H "Content-Type: application/json" \
  -d '{"bbox":"-122.5,37.5,-122.0,38.0","auto_add":true}'
```

### Map Maintenance

```bash
# Stamp every frontend asset with one build token (after any frontend change)
bash scripts/bump_frontend.sh

# Rebuild the hydrological basins overlay (the source zip is a download —
# see the "Hydrological Basins Overlay" section above for the URL)
python3 scripts/basin_build.py

# Rebuild the Facebook friendships overlay (source: NOAA SOS Explorer FTP)
python3 scripts/facebook_build.py

# Rebuild the source geography profiles (the placement gate reads them)
python3 -m worker.source_profiles --all --days 30

# Audit the "one source owns one capital" pileups
python3 -m worker.fix_source_pileups --dry-run

# Normalise news_locations.country to ISO-2
python3 -m worker.normalize_location_countries --dry-run

# Relabel / merge the location table
python3 -m worker.repair_locations --dry-run
python3 -m worker.repair_locations --apply           # relabel + move (fast)
python3 -m worker.repair_locations --apply --merge   # merge duplicates (slow)

# Rebuild the magnetic field overlay (static model — only when a new
# WMM ships every ~5 years, or to roll the evaluation date forward)
python3 -m worker.magmap
python3 -m worker.magmap --verify-only   # just the NOAA test-value gate

# Audit the three GFS overlays against each other and against the raw
# analysis. The isobar check re-reads each source's field ON ITS OWN
# GRID (GFS 0.25°, ECMWF IFS 0.1°) — the field the lines were cut from.
python3 -m worker.gfs_verify              # all three + the cross-checks
python3 -m worker.gfs_verify --field pressure
python3 -m worker.gfs_verify --offline     # self-consistency, no network
python3 -m worker.gfs_verify --json
```

> The repair scripts write to the database — run the `--dry-run` first and
> read the report. `XYZO_DB_DSN` (or `PGPASSWORD`) must be set; no
> credentials live in the repo.

### Monitoring Worker Health

```bash
# Check health status
XYZO_DB_DSN="postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo" \
  python3 -m worker.health_monitor --verbose

# Auto-fix stale leases (after worker crash)
XYZO_DB_DSN="..." python3 -m worker.health_monitor --fix
```

---

## Fetch Scheduling & Fleet Hygiene (2026-09-26)

The fetcher no longer hammers broken doors. Policy, all measured & test-pinned
(`worker/tests/test_fetch_smart_policy.py`):

**Value-weighted exponential backoff.** Each failure reschedules a source:
`1d → 2d → 4d → 8d (cap)` divided by its historical value (`learn.py` bandit's
`reliability_score`: ≥0.7 ÷4 → retries in 6h/12h/1d/2d; ≥0.4 ÷2), floored at 4h.
Success clears the slate. Before this, a failing source retried EVERY cycle —
the web fleet alone burned ~20,400 failed polls/day (93% of all errors).
Columns + index: `api/migrations/2026-09-26-retry-backoff.sql`.

**The zero-value watchlist (RETAIN-AND-OBSERVE).** `python3 -m worker.retire_sources
--check` finds active sources that have NEVER succeeded and contributed ZERO
articles — and splits them by measured demand (`news_location_rankings`).
**Stance (owner decision 2026-09-26): nothing gets deactivated yet** — the user
base is too small for "no demand" to mean "no value". Deep backoff already caps
each dormant source at ~1 poll/8 days, and the list is already shrinking on its
own (1,112 → 965 candidates the same day: 147 sources had their FIRST success
once the scraper fix landed):
- **Tier B (~304)**: blocked big names (BBC Malayalam, Dawn, Jakarta Post, NHK…)
  from countries users actively read → tagged `repair_blocked_high_demand`,
  kept alive, cost capped by backoff. These want a feed-URL/UA repair pass.
- **Tier R (~680)**: zero value, zero demand signal *yet* → kept active on deep
  backoff, re-checked weekly. `--apply --force` exists for the day the audience
  is big enough to judge demand honestly.

Report: `docs/SOURCE_RETIREMENT_2026-09-26.md`.

**Bounded feed parsing.** Feeds are streamed with an 8 MB hard cap
(`MAX_FEED_BYTES`); oversized bodies are salvaged at the last complete
`</item>`/`</entry>` (feeds are newest-first, so the tail we drop is exactly
what `limit_per_source=50` would discard anyway). Protects the 1G-MemoryMax
worker from giant/malicious feeds. Redirects: capped at 6 hops
(`httpx` `TooManyRedirects` → normal error path). **Extended 09-28:** the same
8 MB streaming cap now covers `web_scraper.py` (main page, article fetches,
validate) and `audio_fetch.py` (podcast feeds) — every background httpx path
is bounded.

**Batch-limited lease claims (09-28).** The claim CTE now carries
`LIMIT 200` (`CLAIM_BATCH_SIZE`, env `XYZO_FETCH_CLAIM_BATCH`) and `fetch_all`
loops claim → fetch → re-claim, so every lease is granted minutes before its
source is fetched. Previously the whole ~2,400-source sweep ran under one
5-min lease it could never finish in (expired-lease thrashing). Pinned by
`TestBatchLimitedClaims` in `worker/tests/test_fetch_smart_policy.py`.

**Cooperative CPU load guard.** `python3 -m worker.health_monitor --cpu-guard`
(**installed as a `*/2` cron line 09-28** — it existed since 09-26 but nothing
scheduled it) watches 1-min load vs hardware threads; above 75%
it writes `data/load_pause` and every pipeline cycle (`worker.run`) skips
politely until load drops below 45%. User-triggered paths (search,
pin re-evaluate) always run. Hard caps per unit live in
`deploy/systemd-limits/` (apply with sudo: CPUQuota 100–200% + Nice, sized so
ALL workers together can never exceed ~half the box — you can type).

**Threading inventory** (audited 2026-09-26): fetch 2 host-groups concurrent ×
sequential-within-host (AGENTS rule, live drop-in `XYZO_FETCH_MAX_CONCURRENT_HOSTS=2`);
geocode 1 worker × Nominatim 1 req/s; extract/learn/audio = remote-GPU bound;
`backfill_categories` ProcessPool(8) is MANUAL only (don't run while the site
matters to you). The historical CPU hog was `nn_infer` (79%, every 5 min) —
now has a quota file ready to apply.

**Found & fixed en route:** `learn.update_source_keywords()` held ONE
transaction open across a 200k-statement rebuild (21+ min idle-in-transaction,
observed live blocking DDL; also quadratic DELETEs) → per-source commits +
`news_source_keywords(source_id)` index.

---

## Community Submissions & User Interactivity (2026-09-28)

**Click-to-submit.** Clicking any empty point on the map opens the submitter
overlay pre-pinned to that coordinate. Title is the only required field —
name/email are optional ("Anonymous"), plus optional story details, URL, and
category. Submissions publish as `source_type='community'` pins immediately
if they pass the fast scan, then get a deferred deep check.

**Two-stage moderation** (minimizes LLM spend; nothing blocks the user):

| Stage | Where | What it does | Cost |
|---|---|---|---|
| 1 — fast scan | `api/src/lib/quickmod.ts` (sync in `POST /api/pins`) | Multilingual spam/scam blocklist (15 langs), scam regexes (URL shorteners, WhatsApp/Telegram harvest, crypto), script-aware gibberish detection, caps/punctuation/repetition/link-count checks, zero-width-char stripping, lite topic classifier (12 categories × 13 languages, word-boundary matching). Returns a plain-language "we read this as…" verdict shown to the submitter. Violence/disaster vocabulary is deliberately NEVER blocked — it's a news map. | sub-ms, zero I/O |
| 1b — route gates | `api/src/routes/pins.ts` | (0,0) null-island reject, 7-day exact-title + pg_trgm-similar/250 km dedupe (409), burst limiter 3/10 min + hourly 10/IP + DB velocity 5/h, honeypot | 2 indexed queries |
| 2 — deep check | `worker/pin_moderate.py` via `community_triage` queue (`op=moderate_pin`) | langdetect + doc_type + word-frequency analysis (`word_freq.py`), ocean/land point-in-polygon (`spatial.ne_countries` in the **xyzo_cities** DB), URL → robots.txt verdict + bounded 8 MB fetch + page frequency analysis, then an LLM verdict **only when the circuit breaker says the AI box is free** (12 s cap, strict JSON `{ok, topic, category, reason}`). Reject → `pins.status='hidden'`. Skip → stays published as `deep_ok_no_llm`. | queued, fire-and-forget |

Audit trail: `community_details.mod_fast` / `mod_deep` (JSONB) + `mod_status`
(`fast_published → deep_ok | deep_ok_no_llm | rejected | uncertain`).
Migration: `api/migrations/2026-09-28-community-submissions.sql`.

**News URL submissions.** `POST /api/news/submit` (`api/src/routes/news.ts`)
queues any pasted article/feed URL into `user_news_submissions` (SSRF-guarded
via `lib/ssrf.ts`, 10/h/IP, URL-level dedupe). Pending-only — it never touches
`news_articles` and never scrapes synchronously. UI lives in the Explore
panel's "Submit News" section.

**Article recommendations.** `POST /api/news/:id/recommend` — 👍 button in
pin popups; one vote per IP (`news_article_recommendations`), denormalized
`news_articles.recommend_count` maintained by integer increment, all reads
`::float` + `Math.round()` (BigInt rule).

**Layer toggles.** Bottom-bar Tools group: 📰 News and 👥 Community buttons
persist to `localStorage["xyzo.layerPrefs"]` and filter **server-side** via
`source_type=rss,editorial` / `source_type=community` (comma-separated lists
now supported by `MapPinsQuerySchema`/`ListPinsQuerySchema` —
`SourceTypeFilter` in `validate.ts`). Both off → viewport fetch short-circuits
with a cleared canvas. Explicit searches deliberately bypass the layer filter.

**BigInt audit (09-28).** All ~370 SQL aggregate sites across `api/src/routes/`
were swept: fixed two **live** 500s (`/api/insights/event/:id/stats`,
`/api/region-sources`) plus six latent raw-BIGSERIAL passthroughs
(`city-story.ts` ×3, `service-events.ts` ×2, `nn.ts` feedback id,
`metrics.getStats`), and a semantics bug where `articleCount === 0` was
*never* true for a BigInt (`insights.ts`). Everything else was already
`Number()`/`::cast`-wrapped.

---

## Köppen-Geiger Climate Overlay (source replaced 2026-10-29)

The map can show a **world climate classification** underneath the news pins.

**Source:** Beck et al. (2018), *Present and future Köppen-Geiger climate
classification maps at 1-km resolution*, Scientific Data 5, 180214 —
**CC BY 4.0**, **~920 m per cell**. `https://doi.org/10.6084/m9.figshare.6396959`

```bash
python3 scripts/koppen_build.py            # Beck GeoTIFF -> tiles + grid + metadata
python3 scripts/koppen_build.py --verify-only
```

Fetch the source once if it is not cached:

```bash
curl -L -o /tmp/beck.zip https://ndownloader.figshare.com/files/12407516
# unzip Beck_KG_V1_present_0p0083.tif -> worker/data/koppen/
```

Outputs (all under `public_html/data/koppen/`):

| Artifact | What it is |
|---|---|
| `tiles/{z}/{x}/{y}.png` | XYZ tile pyramid, EPSG:3857, **z0–z7** (21,845 tiles, 36 MB) |
| `grid.png` | Paletted 0.05° lookup grid (7200×3600, 5.6 km) — "climate at this point" |
| `classes.json` | 30 climate classes: code, group, description, criteria, colour, licence |

### Why Beck and not the KML we used before

The previous source was `maps/World_Koppen_Gerrit_Hendriksen.kml`, a
digitisation of Peel et al. (2007) — whose paper is **CC BY-NC-SA 2.5**,
NonCommercial *and* ShareAlike. It was the site's one licence exposure.
Beck et al. is the same classification, peer reviewed, under **CC BY 4.0**,
and thirty times finer. The colours, descriptions and criteria the map
shows are unchanged, so the class key looks identical; only the
classification data moved. Two probes encode the difference: the Amazon
interior is now **Af** (rainforest) where Peel had Am (monsoon), and Beck
carries a **Csc** class the older map lacked (29 classes -> 30).

**Runtime** (`public_html/climate-layer.js`, `window.ClimateLayer`):

- The switch is the **🌍 Köppen Climate checkbox in the Leaflet layers
  control** — the dropdown is collapsed by default, so nothing about the
  climate is on screen until the user opens the layer list.
- **Every overlay in that list has an opacity slider** (and a % readout)
  next to its checkbox. Values are remembered per layer in `localStorage`
  (`xyzo.overlayOpacity`). See `public_html/overlay-opacity.js`.
- Rendered as an `L.tileLayer` in a dedicated `climatePane` (z-index 350) so
  the wash sits above the base tiles but **below** the pin canvas
  (overlayPane 400).
- The **30-class key lives inside the same dropdown**, under the overlay
  list — it is never a floating panel.
- **Hover the map** → a readout shows the climate class under the cursor.
  On touch devices a **Probe** toggle appears next to the key: it turns a
  tap into the same readout (and suppresses the click-to-submit flow
  while it is on).
- The pyramid runs to **z7 = 1,223 m/px**, within **1.3× of Beck's 928 m
  source**. Stop there: z8 (611 m) would oversample the grid, and
  `MAX_NATIVE_ZOOM = 7` in `climate-layer.js` must match the build —
  with it at 5 Leaflet fetched z5 tiles and blew them up 4×, so three
  quarters of the pyramid on disk was never used.
- State persists in `localStorage` (`xyzo.climateLayer`, `xyzo.climateProbe`)
  and round-trips through the URL hash as `/overlay=koppen`
  (`/climate=1` is accepted as an alias).

## River Overlay — Natural Earth (2026-10-28)

1,473 rivers and lake centerlines drawn as a GeoJSON wash, rank-
filtered by zoom.

```
scripts/river_build.py  →  public_html/data/rivers/{rivers.geojson, meta.json}
                                        ↓  static, cached by Caddy
                    public_html/river-layer.js  →  L.geoJSON in riverPane
```

**Source:** Natural Earth 10m Rivers + Lake Centerlines (public
domain), already in the repo as `maps/ne_10m_rivers_lake_centerlines.zip`.

**Vector, not tiles.** 1,473 lines is far too little for a raster
pyramid, and a GeoJSON wash stays crisp at every zoom. The client
styles each feature by Natural Earth's `scalerank` (rank 1 = the
Amazon, always on; rank 9 = a creek, only at street zoom) and filters
by `min_zoom`. **Every rank is visible by zoom 6** — Natural Earth's
own min_zoom hides small rivers until you are almost on top of them,
which is too conservative for this map.

**Labels: ONE PER RIVER NAME, on screen, 70 px apart** (rewritten
2026-11-01 after *"odd names like benue benue over Africa"*). Three
traps, each measured live with Playwright
(`scripts/river_labels_check.py`):

- **Never one label per FEATURE.** Natural Earth **splits a single
  river into several features**, so "one label per feature" drew the
  Benue twice, 43 px apart — at the reporter's URL **11 names were
  doubled** (Benue, São Francisco, Paraná, Tocantins, Ob, Yenisey, …)
  and users read the pair as a glitch. `chooseLabels()` keeps **one
  candidate per name**, the feature with the most vertices (the longest
  stem, so the label sits on the main river and not a tributary
  fragment).
- **Only on-screen rivers are worth a slot.** The old loop walked the
  file and broke at 40, so **20 of 40 slots** were spent on anchors
  outside the viewport and a visible river later in the file never got
  labelled. The bounds are padded (`bounds.pad(0.1)`) so a river
  *entering* the view is already labelled — a label within ~15 % of the
  viewport past an edge is that padding, not a defect.
- **A screen-space gap, because anchors can coincide.** Paraná and
  Paranaíba *join*, so their anchors sat **42 px apart** and the two
  words collided. Two labels closer than `LABEL_MIN_GAP_PX = 70` never
  both place; candidates are ranked (scalerank asc, longest stem
  breaking ties) so the river that loses a slot is the less important
  one — never an arbitrary one.

Because placement is now viewport-dependent, labels **re-place on
`moveend`** (150 ms throttle), not only on `zoomend`. The selector is a
pure function exported as `RiverLayer._chooseLabels(features, opts)` —
the map is the only thing it cannot have, so the tests drive it
directly. Trade-off accepted: two *different* rivers that share a name
get one label (same rule the isobars use for same-level labels).
Live check: **23 labels, 23 distinct names, 0 doubled, 0 far
off-screen** at the reported URL; a scripted pan re-places them the
same way. Rivers **never** block map clicks (`blocksClick()` returns
false).

### The GeoJSON group must provide setOpacity

Leaflet's `L.geoJSON` has no `setOpacity`, and
`OverlayOpacity.mount()` calls `setOpacity` on every overlay in
`WEATHER_OVERLAYS`. A missing method there **throws inside app.js's
boot** and aborts the rest of the script — the `pinMarkers` TDZ crash
of 2026-10-28. `getTileLayer()` attaches `setOpacity`/`getOpacity` to
the instance. `overlay-opacity.js` also guards every call with
`typeof layer.setOpacity === "function"` so a future overlay that
forgets cannot brick the map again.

### Rebuild

```bash
python3 scripts/river_build.py
python3 scripts/river_build.py --verify-only
```

`verify()` requires the Amazon, Nile, Mississippi, Danube, Yangtze and
Congo to be found near their true coordinates. A swapped axis fails
every probe at once.

## River Overlay — FAO AQUASTAT "Rivers (Global, edition 2026)" (2026-11-05)

The REAL river network: every reach on Earth with a catchment of 10 km²
or an average flow of 0.1 m³/s. More than a million reaches, against
Natural Earth's 1,473 cartographic centrelines.

```
scripts/river_network_build.py  →  public_html/data/rivers/fao/{labels.geojson, meta.json}
                                            ↓  static, cached by Caddy
                        public_html/fao-rivers-layer.js  →  L.tileLayer in faoRiverPane
                                            ↓
        ┌───────────────────────────────────┴─────────────────────────────┐
   z0 – z4: OUR OWN TILES                    z5 and deeper: THE PROXY
   scripts/river_network_fetch.py           api/src/routes/faoRiversProxy.ts
     → data/rivers_fao_2026/  (8,477,883 reaches, 654 MB, gitignored,
       OUTSIDE the web root — the upstream licence forbids distributing
       the data standalone, so this copy is the SOURCE for a rendered
       layer and never a download)
     → scripts/river_tiles_build.py
       → public_html/data/rivers/fao/tiles/<level>/<z>/<x>/<y>.png
         (1,364 tiles, 114 MB, four detail levels) — OUR colours, OUR
         widths, the same rules the published SLD uses
                                            ↓
                            the publisher's WMS renders the network at any zoom
                            (cached on disk by the proxy, so it is asked once)
```

**Source:** FAO AQUASTAT / AQUAMAPS, "Rivers (Global, edition 2026)",
published 2026-06-15 and revised 2026-07-16, derived from **HydroRIVERS**
(HydroSHEDS). **CC BY 4.0** — attribution required, and it is printed in
the map's attribution bar.
<https://data.apps.fao.org/catalog/iso/e22667af-3977-4e9f-b58b-67fb91b0fa87>

**The lines are OURS below z5 and the publisher's above it.** The network
cannot be shipped to a reader: a single 10° × 10° box of it is **28 MB**
of GeoJSON, and the whole world is roughly 700 MB. So the tiles are
rendered server-side — **and since 2026-11-06 we render the zoomed-out
half ourselves**, from our own copy of the network, because the
publisher's WMS takes **25-48 s for a whole-world tile** and ~2 s for
anything else. Above z4 the publisher still answers, through our own
caching proxy.

```bash
# fetch the whole 2026 edition (8,477,883 reaches, 212 pages, ~95 min)
python3 scripts/river_network_fetch.py

# render the static pyramid from it (z0-z4 × four detail levels)
python3 scripts/river_tiles_build.py --zoom-max 4
python3 scripts/river_tiles_build.py --verify-only
```

**MEASURED:** the world view arrives in **0.71 s** (18 tiles, all 200),
a country-sized z4 view in **1.63 s** (28 tiles), and a zoomed-in z5 view
in **2.9 s** once the proxy's disk cache has it — **18 s for the very
first reader of an area**, and a local file for everybody after that.

**THE TWO OPTIONS**

| | |
|---|---|
| **Detail** | **Major** (≥ 100 m³/s) · **Medium** (≥ 10) · **Fine** (≥ 1) · **Full detail** (every reach). A `CQL_FILTER` on `dis_av_cms`, so the thinning is **server-side** and the tiles stay small. Measured over the lower Amazon, one 256 px tile: **38 KB / 73 KB / 144 KB / 226 KB**. |
| **River names** | On or off. The 2026 network carries **no name on a reach**, so the names come from the FAO's own classic rivers layer and are published as 5,097 anchor points. |

**THE LEVEL TRAVELS WITH THE LINK** (`/rivers=full`), and a link's level
is a **view** — it does not overwrite the reader's own stored choice.

### The seven traps, all measured

**1. The publisher's style omits 59 % of the network.** Its published
style has rules for `ord_flow` **1..6 only**. Every reach of order 7 and
finer — **42,610 of the 71,687 reaches** over the lower Amazon — is not
drawn by it at all. A GetMap for exactly those reaches comes back as a
tile with **zero opaque pixels**: HTTP 200, no error, an empty map. Our
SLD adds the missing class, and the build checks both halves every time
(it would pass on a server that merely had no data there).

**2. The publisher's cartography is dark-on-light and vanishes on our
dark basemap.** Order 1 is `#042946` — near-black navy — and the pale
classes carry the fine network. Over the default satellite basemap the
main stems disappear and only the tributaries survive. So the client
sends **its own SLD** (`sld_body`), from the same attributes but
**bright at both ends**: the greatest rivers read white, the finest
twigs a pale thread, the intermittent reaches a dashed amber.

**3. `ogc:PropertyIsBetween` crashes GeoServer's renderer.** A dynamic
SLD using it answers HTTP 200 with a ServiceException carrying
`java.lang.NullPointerException` — a blank tile and a silent failure.
A range is expressed as an `ogc:And` of `GreaterThanOrEqualTo` and
`LessThanOrEqualTo` instead.

**4. Every matching rule RENDERS.** The rules are not "first match
wins": a reach matching four of them is drawn four times and the LAST
one is what the reader sees. A cumulative ladder (`ord_flow <= 2`, then
`<= 4`, …) painted the whole Amazon in the palest colour of the ramp.
**The ranges must be disjoint** — and each one carries
`smooth_200 = 'P'`, or a dashed intermittent reach is drawn twice and
the solid one covers the dash.

**5. `tileSize: 512` put the rivers on the WRONG CONTINENT.** (The
canonical statement of the rule is the geology layer's *"Do NOT set
tileSize: 512"* — this is the same trap, and it is why that section
exists.) Leaflet's
`_pxBoundsToTileRange()` divides the pixel bounds by the **tile size**,
so a layer with `tileSize: 512` asks for a **512-px grid** — its tile
(11, 7) covers the ground of the *standard* square (22, 14). Our
pyramid and the publisher are both cut on the standard 256-px grid, so
every tile was fetched from the **north-west quadrant of where it
belonged**: a tile the map wanted at longitude 85° came from longitude
**−56°**, and the rivers were drawn over the Indian Ocean out of
Greenland. It survived every screenshot — the picture still looked like a
plausible river network, just from the wrong hemisphere — and it
survived the pixel-for-pixel comparison with the publisher, because both
sides were being asked the same wrong question. **The fix is one option:
`tileSize` stays at the default 256**, and the sharpness comes from the
IMAGE instead — the publisher renders the standard square at 512×512 and
the browser downscales it into the 256-px slot, which is free (their
cost is the query, not the rasterising). **The line-width hierarchy
needs those pixels**: the classes span 1.25 → 0.35 px, and at 22.8 px/°
every one of them rounds to 1 px and the hierarchy collapses.

**6. A PNG under `public_html` is `immutable` for a YEAR.** So a rebuilt
pyramid behind an unchanged URL is invisible — and the proxy's
`max-age=604800` kept the *misaligned* tiles in readers' browsers for a
week. **Every tile URL carries a `?v=` build token**, because a URL *is*
the cache key; bump `TILE_BUILD` whenever the tiles are rebuilt.

**7. The tile's NORTH edge is the LARGER northing.** In EPSG:3857 y grows
northward, but the slippy ROW index grows southward, so row 0 is the top
of the world and its northing is the largest. Getting the two the wrong
way round **flips the tile vertically** — and a flipped tile is not a
subtle error: the pixel overlap against the publisher's own rendering of
the same ground collapsed from 100 % to **6 %**. **The check that
catches it belongs in the build**: render one tile and compare it with
the publisher's tile for the same square. After the fix the two are
**98 % pixel-identical** (the rest is PIL's hard stroke edges against
GeoServer's antialiased ones).

### The WMS axis order

**WMS 1.3.0 with `srs=EPSG:4326` uses the CRS authority's axis order,
which for EPSG:4326 is (latitude, longitude).** Ask for the Amazon with
`bbox=-62,-5,-52,0` and the server renders **Antarctica** — a blank
tile, a 200 response and no error at all. The server's own capability
document has the same confusion (its EPSG:4326 BoundingBox has minx and
miny swapped). The client asks for **1.1.1**, where the order is
mandated to be (longitude, latitude).

**The WFS and the WMS disagree about the same server.** The WFS
interprets `bbox` as **(miny, minx, maxy, maxx)** whatever `srsName`
says; the WMS (1.1.1) takes (minx, miny, maxx, maxy). A bbox and a
`CQL_FILTER` are also **mutually exclusive** on that server.

### The names

The 2026 edition's attributes are hydrology only — `HYRIV_ID`,
`NEXT_DOWN`, `ORD_FLOW`, `LENGTH_KM`, `DIST_UP_KM`, `DIST_DN_KM`,
`UPLAND_SKM`, `CATCH_SKM`, `DIS_AV_CMS` — **and no `NAME`**. The names
come from the FAO's classic rivers layer (`rivers_world_47950`, 86,882
named features) and are published as one anchor point per name.

**A name is only labelled if it is a river.** `maj_name` and `sub_name`
are BASIN names and many of them are places — "Gobi Interior", "Hudson
Bay Coast", "Lake Chad", "Sahara", "Arabian Peninsula" — so a word list
drops every name that reads as land or sea (**64,912 dropped**, leaving
**5,082**). A trailing digit goes too: "Amur1"…"Amur4" are one river's
numbered sub-basins, not four rivers, and "Orinoco 8" is not "Orinoco 8".

**THE CLASSIC LAYER HAS NO RIVER NAME EITHER — MEASURED (2026-11-09).**
Its 18 attributes are `fid_wld_st`, `arcid`, `from_node`, `to_node`,
`fid_subbas`, `sub_bas`, `maj_bas`, **`maj_name`**, **`sub_name`**,
`maj_area`, `legend`, `subbas_id`, `tobas_id`, `rasterva_1`, `strahler`,
`rastervalu`, `a_strahler`, `regime` — **and not one of them names a
river**. So what the map prints is the name of the **BASIN** a reach
belongs to: "Cahokia / Joachim", "Mississippi - Missouri", "Lower
Mississippi / Memphis". **601 of the 5,097 names are compounds like
that** — a basin name and its sub-basin, joined by the source's own
separator. **THAT IS WHY THE NAMES ARE OFF BY DEFAULT (owner ask
2026-11-08: *"not to show any labels if the user doesn't want to see
them.. so default it without labels"*)**: a name is an OPTION, not the
price of admission. Both river layers now offer the same switch
(`xyzo.faoRivers.labels` / `xyzo.rivers.labels`), both start **off**,
and an explicit "on" is remembered.

**`a_strahler` IS NOT THE RIVER'S ORDER — the hypothesis that it was,
and the measurement that killed it.** The source carries two Strahler
fields: `strahler` (the order of that **segment**) and `a_strahler` (the
order of the **basin** it belongs to), and `a_strahler` is the larger of
the two in **93.3 %** of the 86,882 features — which looks like "the
right field for the label gate". **IT IS NOT**: with `a_strahler` the gate
would admit **5,830 of 5,858** distinct names at zoom 6 (everything),
because every reach of a big basin carries the same high value, and the
list of "biggest rivers" becomes fragments and places ("Boumba",
"Uraricoera", "Gulf of Guinea", "Northeast South America, South Atlantic
Coast"). **`strahler` is the right field**, and the published labels use
it: at zoom 6 the gate (`≥ 4`) leaves **769** names, at zoom 4 (`≥ 5`)
**286**, at zoom 8 (`≥ 3`) **1,902**.

**THREE CLEANUPS, ALL MEASURED ON THE SOURCE (and published 2026-11-09):**

- **THE PUBLISHER'S MANGLED ACCENTS.** 1,546 of the 86,882 features
  carry the UTF-8 of **U+FFFD, encoded a second time** — "Ariï¿½ge"
  for "Ariège". **Verified AT THE SOURCE** (the live WFS returns the
  bytes `c3 af c2 bf c2 bd` for that name), so the character is gone
  from THEIR data and cannot be recovered by any amount of decoding: the
  publisher lost it and published the loss. The map prints a plain **"?"**
  instead ("Ari?ge").
- **AREA DESCRIPTIONS.** 16 names are descriptions in **SPANISH** —
  "Zona de rios en Chaco Boreal", "Zona sin rios de importancia en
  Patagonia", "Pampas Region" — which is why the English word list never
  caught them. They are dropped now.
- **TWO-LETTER ABBREVIATIONS.** "Ko", "Lo", "Ma", "Mu", "Ob", "Po",
  "Yi", "Ye" are the FAO's **abbreviated labels for a sub-basin**:
  measured on the source, "Ko" is a reach of **Lake Chad**, "Lom" of the
  **Danube**, "Mu" of the **Irrawaddy**, "Yi" of the **La Plata**. The
  parent is published under its own name anyway, so dropping the
  abbreviation loses nothing. Three letters is kept ("Ain", "Aare",
  "Amur").

### The upstream licence must survive a rebuild

**The builder OVERWRITES the published `meta.json`, and for a long time
it could not reproduce the UPSTREAM attribution** — the Exhibit B
statement that the HydroSHEDS licence (Appendix A of the Technical
Documentation v1.4) requires to travel with the product's metadata. It
had been published once, by a version of the builder that carried it, so
a rebuild **dropped it** and `data-licences.bun.test.js` failed on the
published file (*"the 2026 rivers carry the UPSTREAM licence's
attribution too"*). **A licence obligation must survive a rebuild**, so
the text now lives in the builder (`UPSTREAM`, `UPSTREAM_ATTRIBUTION`,
`UPSTREAM_CITATION`) and the fetch script — which writes the
out-of-web-root manifest — **imports it from there**: one statement, two
places it travels.

### Rebuild and audit

```bash
python3 scripts/river_network_build.py            # fetch the names, publish, verify
python3 scripts/river_network_build.py --skip-fetch  # rebuild from the cached download
python3 scripts/river_network_build.py --verify-only
python3 scripts/fao_rivers_audit.py                # drive the live map with Playwright
```

`verify()` probes the six great rivers against the **source geometry**
(the Amazon within 0.08°, the Nile 0.03°, the Congo 0.03°, the Yangtze
0.10°, the Danube 0.11°, the Mississippi 0.04°), checks that the four
detail levels draw four **different** pictures, and confirms that the
publisher's style still draws nothing of the fine reaches.

**Bump `BUILD` in `public_html/fao-rivers-layer.js` when the published
data changes** — `meta.json` carries the class table, the SLD and the
levels, and the browser caches it under `?v=`. **A URL IS THE CACHE
KEY**: the labels were rebuilt on 2026-11-09 (the cleanups above) and
`BUILD` moved `20261105 → 20261109` with them, or the rebuilt file
would have been invisible behind the old URL.

## Soil-Type Overlay — FAO/IIASA HWSD v2.2 (2026-11-05)

The **Harmonized World Soil Database v2.2**: every cell on Earth
classified into one of **34 FAO 1990 Revised Legend units** correlated
to WRB 2022 (Acrisols … Vertisols, plus open inland water and
glaciers), at ~1 km / 30 arc-second. It answers *"what kind of soil is
HERE"* — SoilGrids (the other soil layer) answers *"how much sand and
clay is HERE"*. Both are in the dropdown, side by side.

```
       the FAO catalogue URL  ✗ wrong in three ways (see below)
                    ↓  corrected by asking the service
 data.apps.fao.org/map/wmts/wmts?layer=fao-gismgr/GAEZ-V5/maps/HWSDV22 …
                    ↓  hotlinked — a WMTS GetTile IS an XYZ template
        public_html/hwsd-layer.js  →  L.tileLayer in hwsdPane (370)
                    ↓
        the hover probe decodes the tile pixel → the 34-class table
```

**Source:** FAO & IIASA, *Harmonized World Soil Database version 2.2*
(data.apps.fao.org · GAEZ V5), published 2023-01-27, revised
2026-09-30. **CC BY 4.0** — attribution only, printed in the map's
attribution bar as *"Soil type: FAO & IIASA, Harmonized World Soil
Database v2.2 (HWSD) — CC BY 4.0"*.
<https://data.apps.fao.org/catalog/iso/ff5c613c-75bb-46a9-a162-bc728059b465>

**Hotlinked, not baked** — a faithful 1 km pyramid is millions of
tiles, and a WMTS `GetTile` IS an XYZ template Leaflet reads directly,
so it costs zero stored bytes (the same trade as WorldPop, GIBS and
Macrostrat).

### The key must be READABLE, and the panel it lives in is WHITE

The key is injected INTO the layers dropdown — a **white** panel. It was
painted with `color: var(--fg)`, and `--fg` is **#e6edf3**: the pale
foreground of the **dark** theme. On white that measures **1.18:1**, so
the thirty-four soil names were effectively **invisible** (the owner:
*"its difficult to see the soil types on the drop down"*).

It was the **only one of the twenty-two keys** in that dropdown painted
that way — every other key measures 12.6–15.9:1. The same trap the
languages legend had already (AGENTS.md: *"`var(--fg)` renders it
invisible there"*).

The key now uses the palette every other key uses (`#333` labels, `#222`
title), at **13px** (it was 11px, under the legibility sweep's floor),
with **13×13 swatches and a stronger border** — several WRB colours are
pale (Alisols `#ffffbe`, Gypsisols `#fef6a4`, Regosols `#fee3a4`) and
vanish into white without one — and columns wide enough that **"Open
inland water" is no longer cut to "Open inland w…"**.

**And it is findable.** The key sat **3,200 px down a 5,000 px
dropdown**, so a reader who ticked "Soil type" saw the map change and
**no key at all**. Switching the layer on now brings it into view (and
only when it is not already on screen).

### The measurement is a gate, not a one-off

`scripts/legend_contrast_check.py` walks every key in the dropdown,
measures every **text** element against the background actually painted
behind it, and fails under **4.5:1** or **11px**:

```
python3 scripts/legend_contrast_check.py
```

**All 22 keys pass** (the worst is 4.83:1). The script is also what
found the same defect in the **other** keys: the licence credits under
nine of them (`"NOAA NCEP GFS · 2 m air temperature"`, `"Beck et al.
(2018) · CC BY 4.0"`) were **#888 on white — 3.54:1**, and the language
count **#999 — 2.85:1**. **A licence credit nobody can read is a licence
problem, not a style one**, so all of them are now **#666 (5.74:1)** at
≥12px.

### The catalogue URL is wrong in THREE ways

All three were found by asking the service, not by trusting the
catalogue — and all three come back as **HTTP 400** with a body naming
the missing piece, which is the only reason they were findable at all:

| The catalogue says | The service wants |
|---|---|
| `tilematrixset=EPSG:900913` | `tilematrixset=WebMercatorQuad` (the service has no such name as EPSG:900913) |
| *(no `style` parameter)* | `style=default` — WMTS always requires one: `Missing 'GetTile' parameters: {'style'}` |
| `TileCol={y}&TileRow={x}` | `TileCol={x}&TileRow={y}` — the catalogue's are **swapped** |

The swap is the dangerous one: transposed tiles render a
**plausible-looking map of the wrong places**, so nothing errors — the
picture is simply false. (WorldPop's catalogue copy is wrong in the
first two ways but not the third; this is the third time in this repo
that the catalogue, not the service, was the thing to disbelieve.)

### The legend came out of the service's own GetLegendGraphic

`GetLegendGraphic` answers a **221 × 1154 PNG** — one swatch per text
row. The build paired the 34 swatch colours with the 34 class names in
order to produce the `CLASSES` table in `hwsd-layer.js`; the key in the
layers dropdown renders exactly those rows. **If FAO ever re-colours
the legend the table goes stale** — which is why the probe reports
**"unknown colour" instead of guessing** when a pixel is far from every
published swatch (a wrong soil unit is worse than no reading), and why
`hwsd-layer.bun.test.js` pins all 34 names in legend order with 34
distinct hex swatches.

### The key must be INSIDE the section, not beside it (2026-11-06)

Owner: *"i thought we didn't want the OTHER popup for soil we need
that in the main leaflet-control area.. its kinda showing up on the
side when it shouldn't"*.

`mountLegend()` did `list.insertAdjacentElement("afterend", box)` on
`.leaflet-control-layers-list` — which is the `<section>` **itself**,
so the key landed *after* the section, directly in
`.leaflet-control-layers`. That is outside the element Leaflet hides
when the dropdown collapses:

| | panel **closed** | panel **open** |
|---|---|---|
| `<section>` | `display:none`, 0 × 0 | 752,18 · 648 × 817, scrolls (`scrollHeight` 5118) |
| `#hwsd-legend` (before) | **221 × 329 at (1207, 64)** — hanging under the stack button | 843 → 1172, i.e. **below** the list's bottom edge |
| `#hwsd-legend` (after) | 0 × 0, `hidden` | inside the section (index 21 of 32), scrolls with it |
| `#soil-legend` (correct, for comparison) | 0 × 0 | 752,3658 · 260 × 394 |

**Three elements, and only one is safe to add to:**

| element | safe? | why |
|---|---|---|
| `.leaflet-control-layers-overlays` | ✗ | Leaflet **empties** it on every layer change |
| `.leaflet-control-layers-list` (the `<section>`) | ✓ | persists, and it is what collapses |
| `.leaflet-control-layers` (the control) | ✗ | persists, but escapes both the scroll box and the collapsed/expanded toggle |

The fix is `list.appendChild(box)` — a child of the section, a sibling
of the two lists Leaflet rebuilds. The header comment in
`hwsd-layer.js` had always described that; the code did the other
thing, and the comment's "sibling of the lists" was read as "sibling of
the list's container". `hwsd-layer.bun.test.js` now pins
`list.appendChild(box)` and forbids the `afterend` call — asserted on
**comment-stripped** code, because this file's own notes quote the
broken call.

### The probe reads the tile's own pixel

The tiles are pre-coloured, so the class under the cursor is a colour
lookup: each tile is drawn to a canvas **once** (cached by URL, capped
at 400 entries) and `getImageData` reads the one pixel. This needs
`crossOrigin: true` — FAO answers
`Access-Control-Allow-Origin: https://xyzo.org` (verified 2026-11-05),
or the canvas would be tainted and every read would throw. The probe
positions from **container points** (a pane child rides Leaflet's
translate and ends up paneOffset from the cursor), hides when the layer
is off, and defers to `HoverInfo.suppressesProbes()` so "Everything"
mode never shows two boxes.

### Traps this layer shipped with (each found by running it)

1. **`mountLegend()` returned `true` when the list did not exist yet**
   — which told `waitForLayersControl()` the key was mounted and
   stopped the retry. app.js's layer-init loop runs BEFORE
   `L.control.layers()` creates `.leaflet-control-layers-list`, so the
   first attempt *always* fails: the legend never appeared. No-list is
   a **failure**, not a success.
2. **`init()` set `state.enabled` from localStorage but registered no
   `overlayadd`/`overlayremove` listeners** — so a shared link that
   added the layer left `state.enabled` false: the legend stayed hidden
   and the probe returned null over a map that **was** showing the
   tiles (measured: 35 tiles, `legend hidden: true`, `probe: None`).
   The population-layer rule now applies: **listeners before the
   restore**, and the stored preference flips `state.enabled` directly
   because the control does not exist yet to fire `overlayadd`.
3. **`PANE_Z = "370"` (quoted) is invisible to
   `overlay-contracts.bun.test.js`'s `Z_RE`**, which reads
   `PANE_Z = <digits>` — the test then reports *"declares a pane but
   no z-index"*. Unquoted, like `population-layer.js`.

### Pane 370, and why the wind moved to 379

The stack was **full from 345 to 370**; a ground-level layer at 371+
would have drawn **over** the wind streaks — exactly the "I can't see
the wind" report. The wind animation moved **370 → 379** (just under
the city labels at 380): it is the topmost weather layer and was
already above the earthquake/fault/ocean-current markers, so 379
changes nothing it was already above. Free slots are now **372–378**
(371 went to the FAO river network).

### Registration: the generic registry, not the OVERLAYS table

HWSD is wired through `generic-layers.js` (like WorldPop): app.js's
loop calls `getTileLayer()`/`init()` for every name in
`XYZO_GENERIC_LAYERS`. It is therefore **deliberately absent from
`overlay-contracts.bun.test.js`'s `OVERLAYS` table** — that table's
boot contract demands literal `window.HWSDLayer.init(map)` /
`typeof window.HWSDLayer.getTileLayer` wiring in app.js, which a
registry layer can never satisfy, so membership would fail for a reason
unrelated to the layer's own correctness (the exact trap
`generic-layers.js`'s header was written to avoid). Its contracts live
in **`public_html/tests/hwsd-layer.bun.test.js` (27 tests)** instead,
and the source-scanning pane test still finds `hwsdPane` on its own.

**One parity gap was closed along the way:** `panel-parity.bun.test.js`
scanned modules for `LAYER_NAME: "…"` (the object-shorthand form) only,
so a module declaring `const LAYER_NAME = "…"` — HWSD, mag, wind,
ocean-current — was **invisible** to *"added to the flat map but
neither ported nor listed in `NOT_PORTED`"*. HWSD is the first
generic-loop module with no literal registration in app.js to fall
through that hole; the scanner now accepts both forms, and HWSD carries
a `NOT_PORTED` entry (hotlinked FAO WMTS — same shape as WorldPop).

**Opacity has no key of its own.** `overlay-opacity.js`'s
`xyzo.overlayOpacity` (keyed by `LAYER_NAME`) is the single store that
restores on the next visit; a second key written-but-never-read would
drift from it.

## Phytoplankton Overlay — MIT Darwin Project (2026-10-28)

Which phytoplankton dominates each patch of ocean, and how much of it
there is. A four-category wash of the MIT Darwin Project's global ocean
ecosystem model, with the biomass carried by the opacity and a switcher
for the twelve monthly means.

```
scripts/phytoplankton_build.py  →  public_html/data/phytoplankton/{meta.json,
                                         annual.bin, m01.bin … m12.bin}
                                        ↓  static, cached by Caddy
                  public_html/phytoplankton-layer.js  →  L.GridLayer in phytoplanktonPane
```

**Source:** the MIT Darwin Project's 1994-1999 global simulation, run
inside the MITgcm / ECCO-2 physical model —
`https://sos.noaa.gov/catalog/datasets/phytoplankton-model/`. MITgcm
and the model are under the **MIT Licence**; the NASA side is public
domain. The attribution travels on the map.

### The published data is a rendering, so the numbers are recovered

The distribution is **2,191 daily equirectangular PNG frames** plus a
colour bar — the monthly maps exist only *inside the frames*. So
`scripts/phytoplankton_build.py` inverts the dataset's **own colour
bar**: four ramps, each 0-5 mmol P m⁻², one per type (Prochlorococcus
green, Synechococcus cyan, Flagellates yellow, Diatoms red).

Three things had to be right, and each one has a trap:

- **The type is decided by the channel structure, not by the nearest
  ramp point.** At near-zero biomass the four ramps' zero ends are
  within ~40 RGB units of each other, so a nearest-point search flips
  the type at random exactly where the gyres are.
- **The land is masked with Natural Earth, not with the residual
  alone.** The frames carry a photographic background and brown desert
  sits inside the yellow flagellate ramp, so a residual test alone
  reads the Sahara as flagellates.
- **The dominant type is the one with the greatest TOTAL biomass, not
  the greatest mean** — in the gyres the type is the same every month
  but at a tiny biomass, and one bright month of another type would
  otherwise win on the mean.

Only the extracted ocean field is published; the photographic
background in the source frames is **not** redistributed.

### The result

Diatoms own the Southern Ocean, the Arctic and the subarctic
convergence zones; prochlorococcus and synechococcus hold the
oligotrophic gyres; the equatorial upwelling is the most productive
tropical water. The mean phosphorus biomass by type comes out as
prochlorococcus 12/255 < synechococcus 21 < flagellates 37 < diatoms
39 — the large, fast-growing species carry more phosphorus, which is
what the dataset's own description says they should.

### Rebuild

```bash
python3 scripts/phytoplankton_build.py
python3 scripts/phytoplankton_build.py --verify-only
```

`verify()` is a gate: the ocean modelled and the land not, all four
types present with none dominating, the Southern Ocean / Weddell Sea /
Arctic diatom-dominated, the subtropical gyres synechococcus, the
equatorial upwelling beating a gyre, the large phytoplankton carrying
more phosphorus than the small ones, and every published period the
right size.

## Lightning Density Overlay — WWLLN (2026-10-28)

Where on Earth the lightning is, and when. A colour wash of the finest
global lightning climatology in the public domain, with a switcher for
the twelve monthly means — the seasonal migration of the ITCZ is the
whole point of the dataset and an annual map cannot show it.

```
scripts/lightning_build.py  →  public_html/data/lightning/{meta.json,
                                     grid_annual.bin, grid_m01.bin … grid_m12.bin}
                                        ↓  static, cached by Caddy
                    public_html/lightning-layer.js  →  L.GridLayer in lightningPane
```

**Source:** the WWLLN Global Lightning Climatology (WGLC) v2 —
`https://doi.org/10.5281/zenodo.20277101`, **CC BY 4.0**. The NetCDF is
downloaded once and cached at `worker/data/wglc_climatology_05m_monthly.nc`
(144 MB; sha256 pinned in the builder).

### Why WGLC and not the NASA LIS/OTD map everyone shares

The geology.com / Science On a Sphere map is NASA LIS/OTD: a **0.5°
grid, about 55 km per cell**, from 1995-2013. WGLC is **5 arc-minutes,
about 9.3 km per cell** — six times finer — and covers 2020-2022. It is
the finest global lightning climatology that exists. There is no free
1 km global climatology: WWLLN's individual *stroke* locations are ~1 km
accurate, but the published density grid is 5 arc-minutes.

These are **stroke** densities, not NASA flash densities. WWLLN detects
cloud-to-ground strokes; LIS counts every flash including intracloud.
Maracaibo reads ~46 strokes/km²/yr here against NASA's ~232
flashes/km²/yr, and Florida ~9 against ~59. The legend says "strokes",
never "flashes".

### The colour scale is a power law

`t = (v / v_max) ** 0.4`, with `v_max = 0.15` for **every** period. The
median cell on Earth is 3e-5 strokes km⁻² d⁻¹ and the maximum is 0.144
— a factor of 4800 — so a linear ramp would paint the whole world one
colour. One scale for all thirteen periods means a cell that is orange
in January is orange in July.

Alpha is separate from the ramp: 40 % of the globe has no lightning at
all, and painting that opaque black would bury the coastlines under a
black rectangle.

### The pixel offset within a tile is 1/(size·n) of the world

A tile is 1/n of the world, so one pixel of it is 1/(size·n) of the
world — not 1/size. Dividing the within-tile offset by `size` alone
spreads the whole globe across every tile: invisible at zoom 0 (n = 1)
and at zoom 7 it throws the field hundreds of degrees away from where it
belongs. The result is a garbled map that still *looks* like a plausible
map, so no screenshot catches it.
`LightningLayer._test.pixelLatLon()` is exported so the test suite can
pin the mapping.

### Rebuild

```bash
python3 scripts/lightning_build.py
python3 scripts/lightning_build.py --verify-only
```

`verify()` is a gate: the annual maximum in the tropics, 60-85 % of the
global density between 30°S and 30°N (NOAA's own figure for this
dataset family is "about 70 %"), the poles under 1 %, the Sahara far
drier than the Congo, ten known hotspots, longitude not mirrored, July a
northern-hemisphere season and December a southern one, December peaking
over the Maritime Continent and July over Mexico.

## Geology Overlay — Macrostrat bedrock + USGS/GSC contacts (2026-10-28)

Colourful bedrock geology and the fault/contact line network, two
layers-control entries sharing one module.

```
Macrostrat tiles.macrostrat.org/carto/{z}/{x}/{y}.png   (hotlinked, CORS *)
USGS WMS     mrdata.usgs.gov/services/worldgeol LAYERS=contacts
                                        ↓  both external tile services
                    public_html/geology-layer.js  →  two tileLayers in geologyPane
```

**Sources (both free, both CORS `*`):**

- **Macrostrat** — https://macrostrat.org, CC BY 4.0 (UW Macrostrat
  Lab / NSF). 512 px PNG tiles, real unit polygons through **z14**
  (~4 m/px — far past the 1 km detail anyone reads on a web map).
  Thousands of units composited from national geological surveys,
  including the GSC 1:35M world compilation the USGS hosts. The probe
  API (`/api/v2/geologic_units/map?lat=&lng=`) returns the unit's
  name, age range, lithology and description for the point under the
  cursor.
- **USGS / Geological Survey of Canada** — WMS 1.1.1 at
  `mrdata.usgs.gov/services/worldgeol`, layer `contacts`. This is the
  *General geologic map of the world* (GSC Open File 2915): the unit
  boundaries (faults and stratigraphic contacts) as thin black lines
  on transparent PNG, in EPSG:3857. A CSS filter inverts them to
  bright white so they read on the dark satellite basemap.

### Hotlinked, not baked

Baking Macrostrat's pyramid globally is impossible (4^14 tiles at
z14). The tile server *is* the product, so the layer hotlinks — the
same trade the NASA GIBS overlays already made. Ocean tiles are 1 KB
transparent PNGs (200, not 404), so the console stays clean and no
Caddy empty-tile fallback is needed here. There is no BUILD token:
nothing is written under `public_html/data/geology/`.

### The probe IS the legend

Macrostrat has thousands of units — a static key is impossible. The
probe queries the point API (debounced 250 ms, cached to 0.1°) and
shows the unit's name, age range and lithology under the cursor.
Arm it with the **Probe** button in the layers dropdown (required on
touch; optional on desktop where hover works once armed).

### Do NOT set tileSize: 512

Macrostrat serves 512 px PNG tiles, but they use the **standard XYZ
z/x/y grid** — same geographic bounds as normal 256 px tiles, just
higher resolution (a "retina" tile). Leaflet's CRS scale is fixed at
`256 * 2^z`; setting `tileSize: 512` tells Leaflet each tile step is
512 CRS-pixels, which places every tile at **2× spacing covering 2×
area** — the whole overlay comes out stretched and shifted (the
incident of 2026-10-28). Keep the default 256; the browser downscales
the 512 px image into the correct slot. Macrostrat's own map sidesteps
this by rendering their vector tiles (`carto-slim/*.mvt`) instead.
Pinned by `overlay-contracts.bun.test.js` as a negative so nobody
"fixes" it back.

### The contacts WMS draws black lines

Without a filter they are invisible on the dark basemaps. The layer
carries `className: "xyzo-geology-contacts"` and the CSS applies
`filter: invert(1) brightness(2.2) contrast(1.1)` — black becomes
white. If you change the basemap to a light one, revisit that filter.

### Layers

| Entry | What it draws |
|---|---|
| 🪨 Geology (Macrostrat) | Colourful bedrock units (the Macrostrat palette) |
| 🗺️ Geologic contacts (USGS) | Fault / contact line network (GSC 1:35M) |

Both get the standard opacity slider; both live in `geologyPane`
(z-index 354 — above cropland, below temperature). Probe mode blocks
click-to-submit like the other probe layers.

## City-Name Labels Overlay (2026-10-28)

An optional overlay that writes city names onto a dedicated canvas —
`🏙️ City names` in the layers dropdown.

**Source: the file we already ship.** `/data/cities.10k.json` (44,487
geocoded cities with population) is the same gazetteer `city-engine.js`
loads for search. The label layer calls `CityEngine.load()` and reads
`_state().allCities` — **it never fetches the 4 MB a second time**.
A direct fetch exists only as a fallback if the module is somehow
absent.

> NOAA's Science-on-a-Sphere "city names" dataset (the link in the
> request) is a **single 4096 px PNG overlay for a globe projection** —
> not a tile pyramid. It would be unreadable past z3 and cannot be
> population-filtered. Local geocoded labels beat it at every zoom.

### Density is controlled two ways

1. **A population floor that rises as you zoom out** (`MIN_POP`):
   | zoom | floor | ≈ visible |
   |---|---|---|
   | 0–1 | 10 M | 40 megacities |
   | 2 | 5 M | 156 |
   | 4 | 1 M | 789 |
   | 6 | 200 k | 3,704 |
   | 7+ | 0 | all 44,487 (viewport-culled) |
2. **Greedy collision avoidance**: candidates are pre-sorted
   population-descending and drawn largest-first; a label whose box
   overlaps one already placed is skipped. A hard cap of 400 labels per
   frame bounds the worst case (world view at z7).

### One canvas, redrawn only when the projection is final

Labels live in `cityLabelPane` (z-index **380** — above wind 370,
below the pins at 400) and are re-rendered only on `moveend` /
`zoomend` / `resize` (debounced 80 ms) — never per frame: city names
do not move relative to the ground between those events. While dragging
the canvas is hidden (`visibility: hidden`) so a stale projection reads
as loading rather than glitching.

Text is white with a dark outline — readable on satellite *and* the
dark basemaps — with font size stepping up by population so hierarchy
reads at a glance. Cities ≥ 500 k also get a small dot marking the
exact point.

Labels **never block clicks** (`blocksClick()` returns false; the canvas
is `pointer-events: none`).

### Rebuild

None — the data ships in the repo. If `data/cities.10k.json` is ever
regenerated, nothing about this module changes.

## Topography & Bathymetry (ETOPO) (2026-10-28)

A relief overlay — land topography and ocean bathymetry in one
colour-shaded map — as `⛰️ Relief (ETOPO)` in the layers dropdown.

```
scripts/etopo_build.py  →  public_html/data/etopo/{tiles,grid.bin,meta.json}
                                        ↓  static, cached by Caddy
                    public_html/etopo-layer.js  →  tileLayer in etopoPane
```

**Source:** NOAA NCEI **ETOPO 2022 v1, 60 arc-second "surface"** (ice
surface), ~466 MB GeoTIFF, public domain. Why ETOPO2022 and not ETOPO1
(the SOS catalog link in the request): NOAA retired the ETOPO1
downloads (they 404). ETOPO2022 at 60 arc-seconds **is the same
1 arc-minute spec** ETOPO1 shipped at — the maintained successor of the
same product line — and "surface" is the Ice-Surface variant the SOS
page described.

### The 466 MB source is downloaded once, outside the repo

`ensure_source()` pulls the GeoTIFF into `~/.xyzo/etopo/` (resumable
via HTTP Range, content-length guarded against truncation) and every
rebuild reuses it. `--skip-download` makes offline rebuilds fail
instead of silently producing garbage. Nothing large is ever committed.

### One fixed palette, 31 bins × 8 shade steps

Tiles are paletted PNGs sharing **one global palette**: a hypsometric
ramp quantised to 31 elevation bins (finer near sea level so the shelf
and coastal plain stay readable) × 8 hillshade steps = 249 slots. Every
tile uses the same table, so a colour that crosses a tile boundary is
pixel-identical on both sides — no seams. A per-tile adaptive palette
would make the gradient step differently in each tile; the test pins
the global-palette decision.

The hillshade is a Horn shading (azimuth 315°, altitude 45°) computed
per strip in numpy. **`slope = arctan(hypot(dzdx, dzdy))`** — using
the raw gradient magnitude as the angle feeds huge numbers into
sin/cos and collapses the shade to 0 on any steep terrain (pinned by
test).

### verify() is calibrated to the model's own resolution

A 60-arc-second (~1.8 km) grid averages peaks and trenches across a
whole cell: Everest comes out ~6,700 m and Challenger Deep ~−10,000 m,
not their survey extremes. The probe bounds match what the model
actually produces — the gate's job is catching a flipped axis or a
scrambled row order, not second-guessing the source's smoothing.

### Layers

| Entry | What it draws |
|---|---|
| ⛰️ Relief (ETOPO) | Colour-shaded topography + bathymetry with baked hillshade |

Lives in `etopoPane` (z-index 345 — above the base tiles, below the
climate wash at 350). Standard opacity slider. Probe mode shows the
elevation under the cursor in **both metres and feet** (read from
`grid.bin`, 0.1° Int16). Hash slugs: `etopo`, `relief`, `topography`,
`bathymetry`.

### Rebuild

```bash
python3 scripts/etopo_build.py                    # verify + pyramid z0..7
python3 scripts/etopo_build.py --verify-only       # just the elevation gate
python3 scripts/etopo_build.py --max-zoom 6        # smaller pyramid
python3 scripts/etopo_build.py --skip-download     # offline (source cached)
```

Bump `BUILD` in `etopo-layer.js` after any rebuild (PNGs are
Caddy-immutable for a year). `maxNativeZoom: 7` ≈ 1.2 km/px — past
that Leaflet upscales; the source is only 1.8 km.

## Wave Height & Power Overlay (2026-10-29)

`🌊 Wave height & power` — the global sea-state field with a derived
wave-power view, one layers-control entry with a Height | Power
switcher.

```
worker/wavemap.py  →  public_html/data/wave/{height.bin, period.bin, meta.json}
                                        ↓  static, revalidated by Caddy
                    public_html/wave-layer.js  →  GridLayer in wavePane
```

**Source: NOAA NCEP GFS Wave (gfswave)**, global 0.25° analysis —
free, **no key**, US Government work. The GRIB is 11.5 MB, fetched
whole every 6-hour GFS cycle.

### The path matters: `/com/wave/` is ACL-blocked; the GFS tree is not

NOMADS' `/pub/data/nccf/com/wave/` tree answers **403** from this
host — but the *same* gfswave products are published under the GFS
tree at
`com/gfs/prod/gfs.YYYYMMDD/HH/wave/gridded/gfswave.tHHz.global.0p25.f000.grib2`,
which is open. There is no filter server; the file is small enough to
take whole. An earlier draft used the Open-Meteo Marine point API —
the keyless tier burns out on a global bake (minutely → hourly →
daily 429s), and the `0p16` file named "global" is secretly a
**52.5N..15S band** (every message in it shares that grid). The
`global.0p25` product is a true **90N..90S** grid: 1440×721 cells of
0.25° (~27 km).

### The worker is a no-op when the cycle has not advanced

`latest_cycle()` walks back up to 3 days × 4 cycles, HEAD-ing until it
finds a run newer than the `run_time` already in `meta.json`. A timer
tick that lands before the new analysis is published simply logs
"nothing to do" — same posture as the wind and isobar workers.

### Power is derived, not fetched

    P [kW/m] ≈ 0.49 · Hs² · Te    with Te ≈ 0.9·Tp   (wind-sea)
            = 0.441 · Hs² · Tp

The constants live in **both** `worker/wavemap.py` and
`wave-layer.js` — pinned by tests on each side so the probe's kW/m can
never drift from the published formula. One fetch (height + period
grids), two fields, no third grid to keep in sync.

### verify() catches axis flips and a wrong longitude roll

A live sea state has no "correct" value to assert, so the gate checks
structure: land cells (Sahara, Iceland interior) must be NULL, open
ocean must be populated with physically-plausible heights, and the
valid fraction must sit in 0.45–0.85 (the wave model additionally
masks ice and marginal seas, so ~54 % is normal; a flipped or
un-rolled grid drops far below that). The GRIB is 0..360° longitude
and the frontend samples `ix = (lon+180)/step` — the worker rolls the
grid to -180..180° and a Sahara probe that lands on the Indian Ocean
fails immediately.

### Layers

| Entry | What it draws |
|---|---|
| 🌊 Wave height & power | Colour field, switchable Height (m) / Power (kW/m) |

Lives in `wavePane` (z-index 346 — above the relief at 345, below the
climate wash at 350). Standard opacity slider. Probe shows metres,
period in seconds **and** kW/m together. Hash slugs: `waves`, `wave`,
`wave-height`, `wave-power`.

Bilinear sampling drops nodata corners and refuses majority-land cells
(`wsum < 0.5`) so coastlines get no dark fringe — the field is sampled
as NUMBERS per tile pixel, never upscaled from an already-coloured
canvas.

### Rebuild / timer

```bash
python3 -m worker.wavemap                 # fetch latest cycle, verify, write
python3 -m worker.wavemap --dry-run        # fetch + verify, write nothing
python3 -m worker.wavemap --verify-only    # re-check the published grid
python3 -m worker.wavemap --run 2026102900 # force a specific GFS cycle
```

`xyzo-wavemap.timer` runs every 6 h. To install:

```bash
sudo cp deploy/xyzo-wavemap.service deploy/xyzo-wavemap.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now xyzo-wavemap.timer
```

The service exits via `os._exit()` (eccodes teardown) and writes
nothing when GFS has not advanced.

## Magnetic Field Overlay — WMM2025 (2026-10-28, extended 2026-10-30)

**Four components × two modes = eight selectable fields**: D
(declination), F (total force), H (horizontal force) and I (inclination),
each with its **main field** value at the evaluation date and its
**secular-variation** rate — the two chart series NCEI tabulates as its
Miller-Projection "Main Field" and "Secular Variation" maps. Each field
brings its own contour family (isogonics / isodynamics / isohorizontals /
isoclinics for the mains, isoporics + `isoporics-{i,f,h}` for the rates),
its own colour wash, ramp, label spacing and probe value.

```
worker/magmap.py  →  public_html/data/mag/{isogonics, isodynamics,
                                           isohorizontals, isoclinics,
                                           isoporics, isoporics-i,
                                           isoporics-f, isoporics-h}.geojson
                     grid_{d,f,h,i,ddot,fdot,hdot,idot}.bin
                     mask.bin, meta.json
                                        ↓  static, revalidated by Caddy
                  public_html/mag-layer.js  →  two selector rows +
                                               L.geoJSON lines (one
                                               family at a time) +
                                               optional baked wash +
                                               probe, in magPane
                  public_html/globe.js      →  the same eight fields on
                                               the 3D globe: one line
                                               layer + one wash, swapped
                                               to the picked field
```

**Source:** WMM2025 (`ncei.noaa.gov/products/world-magnetic-model`),
US Government work — public domain. The whole model is a 3 KB
coefficient file: 90 Gauss coefficients, each row carrying both the
main-field term and its secular-variation rate. **All eight fields come
from this one file** — F and H are magnitudes derived from the same X/Y/Z
synthesis (`F = √(H²+Z²)`, `H = √(X²+Y²)`), and every rate is the
analytic chain-rule derivative of the same coefficients.

NCEI also publishes this field as **ready-made contour shapefiles**
(`data.ngdc.noaa.gov/geomag/wmm/wmm2025/shapefiles/` — D/I/H/X/Y/Z/F and
their rates) and `meta.json` records that URL as the upstream product.
**The overlay does not use them**: those files are *lines with no grids*,
so the wash and the probe would still have to come from the coefficient
file — and running colour from one source and lines from another is
exactly how the two eventually disagree. One source, `WMM.COF`, checked
against NOAA's published numbers.

The coefficient file is **vendored** at `worker/data/WMM2025.COF` —
NCEI is mid-cloud-migration and their downloads have been
intermittently unavailable, so a build must never depend on their
uptime (`--fetch` refreshes the copy).

**This is a static model — no timer, no fetch cycle, no GRIB.** The
WMM changes over years, not hours (a new one ships every ~5 years;
WMM2030 is expected late 2029). Rebuild with
`python3 -m worker.magmap` when a new WMM ships or to roll the
evaluation date forward.

### The verify() gate is NOAA's own test values

The synthesis must reproduce the ~100 points NCEI publishes alongside
the model (both hemispheres, altitudes to 94 km, dates across the
life span): **D/I to 0.005°, X/Y/Z and F/H to under 0.001 nT, and the
annual rates to 0.00001°/yr (D, I) and 1e-6 nT/yr (F, H)**. A sign flip,
a transposed Gauss-coefficient index or a missing Schmidt factor fails
here — a wrong synthesis still produces a field that *looks* like Earth's,
so only known-point probes against somebody else's numbers can catch it.

On top of the test points, `verify()` checks the whole grid for
**relationships that hold only if the planes are what they claim**:

- `F ≥ H ≥ 0` and `F ≥ |Z|` pointwise — from `F = √(H²+Z²)`, so a
  swapped pair or a scale applied twice breaks it while still painting a
  plausible-looking wash;
- every field's ramp **brackets every cell the wash can paint** (checked
  outside the blackout zone for D and ΔD, where those rates legitimately
  blow up), and every visible cell survives the Int16 encode without
  clipping — `encode_plane()` clips, never wraps, so an overflowing plane
  is silently *flattened* rather than wrong-shaped;
- the blackout mask is still two small polar caps (0.05–5 % of the grid,
  both inside ±60°).

Three real bugs were caught by that gate during the build:

1. **Coefficient indexing** — reading the Gauss tables order-major
   instead of degree-major negated most of the field (179.5° worst
   error).
2. **Forward-difference SV** — the published annual change is the
   analytic chain-rule rate `dD/dt = (X·Ẏ − Y·Ẋ)/H²`, not
   `D(t+1) − D(t)`; the two disagree by 0.1°/yr at the dip poles,
   where D curves fast and H is small.
3. **Longitude origin** — the torus-window contouring math (copied
   from the isobar pipeline) assumes the GFS convention 0..359. With
   a −180 origin every contoured line came out shifted by 180° while
   still looking like a plausible curve.

### Contouring declination through X and Y

Declination is an ANGLE in [−180, +180]. A cell straddling the ±180
branch cut holds two corners ~358° apart while the true field barely
changes, so marching squares on D directly draws a FALSE line
wherever D wraps. The isogonic line at level L is instead the zero
set of the smooth scalar `S_L = Y·cos L − X·sin L` — linear in the
smooth components X and Y, no branch cut anywhere. That zero set
contains BOTH the D = L and D = L+180 lines; the companion
`P_L = X·cos L + Y·sin L = ±H` tells them apart by SIGN.

Each stitched polyline is **cut wherever the sign of P_L flips** and
every constant-sign run gets its own level. Without that cut the
branches — which converge at the dip pole where H → 0 and the stitch
walks straight through the meeting point — share one level, and the
±100…±180 family (the lines circling each magnetic pole) is silently
stolen by the mid-levels. Inclination lives in [−90, +90] with no
wrap, so it is contoured directly.

### The selector: four components × two modes

The layers dropdown carries **two chip rows** under the legend, not eight
checkboxes — a component row (Declination / Total force / Horizontal /
Inclination) and a value row (Main field / Change per year). Both are
**built from the tables** (`COMPONENT_ORDER` / `MODE_ORDER` in
`mag-layer.js`, `meta.components` / `meta.modes` on the globe), so a field
added to the worker appears as a chip without a second edit.

Three per-field rules only make sense once a field can be picked, and all
three are gated:

1. **Per-field Int16 scale.** One scale cannot serve a ±180° angle and a
   67,000 nT magnitude (67,000 × 100 is two orders of magnitude past
   Int16's 32,767). `meta.grid.scale` stays **100** — the default the
   original four fields shipped with, and the only scale an *old* cached
   meta.json knows — while `meta.fields[k].scale` is what the browser
   divides by: **0.25 for F, 0.5 for H, 100 elsewhere**. `verify()` fails
   a plane whose `value × scale` would clip, because `encode_plane()`
   clips rather than wraps: an overflowing field is not misshapen, it is
   **flattened at the extremes**.
2. **Per-field blackout.** The BoZ (H < 2000 nT) blanks only **D and
   ΔD** — D has no answer at the dip pole and ΔD divides by H². F is at
   its *strongest* there, H is merely small, I runs smoothly to ±90°:
   masking all eight would erase the poles from exactly the two charts
   that show them best. The probe names the one value with no reading
   (`Blackout zone — D undefined here · F 56,214 nT · …`) instead of
   blanking three good ones.
3. **Ramp by shape.** Signed fields keep a diverging ramp (zero *is*
   the landmark) — **violet → azure → cyan → gold → crimson**, with the
   centre saturated rather than pastel and with no green stop on it
   (see "The wash ramps" below). F and H are one-sided magnitudes with no
   meaningful zero in range, so they take a **sequential**
   indigo → violet → rose → amber ramp — a diverging one would spend half
   the spectrum on values that never occur and paint the low end in a
   colour that means "negative".

Two consequences worth knowing: the colour LUT is sized at **1/1440 of
the field's range** (the old fixed 0.25° step was right for D — 360° ÷
1440 = 0.25° — but would have allocated 180,001 entries for F's 45,000 nT
span), and the below-zoom-5 label spacing is **per field** (`label_step`
in meta): 30° for D/I as before, 5,000 nT for F/H, 50 nT/yr for the
force rates. A single hardcoded 30 would leave F contoured but
**unlabelled**, because no level on a 23,000–67,000 nT field is a
multiple of 30.

The choice persists in `localStorage["xyzo.magComponent"]` +
`["xyzo.magMode"]`, and the old single-key value migrates: `"sv"` was a
*component* then and is a *mode* now, so it becomes declination +
change-per-year — the same field the chip used to show.

### On the 3D globe

`globe.html` loads only MapLibre + `globe.js` (no Leaflet, so
`mag-layer.js` cannot come along), and **reads every field from
`meta.json`** — the file names, scales, ramps, ranges and blackout flags
are all in `meta.fields[k]`, so the two views cannot disagree about what
a colour means. The overlay panel gets a matching chip pair under the mag
row, persisted in `settings.magView`.

The globe draws **one line layer + one colour wash with static ids**
(`mag-lines`, `mag-wash`) and swaps data *through* them. Its previous
design built three per-family line layers from a list written out twice
(`layerIdsFor` and the adder) — which is how `isoporics` shipped invisible
for a day, and why the id list and the opacity loop are now the same two
expressions in both places. The wash is an equirectangular canvas draped
as a MapLibre **image source** (the temperature pattern, corners inset to
±89.5° because ±90° projects to y=Infinity and the source silently never
renders); image sources have no `setData`, so a switch removes and
re-adds it, and a generation counter makes a fast second click win so a
slow first fetch cannot repaint the field the user just left. **One
opacity slider** drives both halves (`line-opacity` + `raster-opacity`).

### Two ranks of line, and the isoporics

Like a topographic map, the chart draws **index contours** (bold,
labelled) over a mesh of **intermediate contours** (thin). Every GeoJSON
feature carries `major: true|false`; the frontend hides the minors below
zoom 4 so the world view stays readable and never labels them.

The intervals come from `LINE_INTERVALS`, in the *contouring* unit (the
rate planes are stored in arcmin/yr but contoured in the model's natural
°/yr, which is how the original isoporics already worked):

| family | interval | index |
|---|---|---|
| isogonics (D), isoclinics (I) | 2° | 10° — a property of how declination charts are read |
| isodynamics (F), isohorizontals (H) | 1,000 nT | 5,000 nT (≈ 45 lines across 22,000–67,000 nT) |
| isoporics (ΔD) | 0.25 °/yr | 1.0 °/yr |
| isoporics-i (ΔI) | 0.05 °/yr | 0.25 °/yr |
| isoporics-f (ΔF), isoporics-h (ΔH) | 10 nT/yr | 50 nT/yr |

**"Isoporic" literally means equal rate of change**, so all four rate
families are isoporics — the suffix says which component. A rate is not an
angle, so ΔI/ΔF/ΔH are contoured directly like inclination (only D needs
the branch-cut trick), and each family's zero line ("No change") is
flagged like the agonic. Levels are built from **integer multiples of the
step**, not repeated float addition: 0.05 accumulated thirteen times
drifts, and a level that lands at 0.1499999999999999 contours a hair
beside the line it claims to be.

### The wash ramps: cyan at zero, no green anywhere

Signed fields (D, I and all four rates) use a **diverging — violet →
azure → CYAN (zero) → gold → crimson** ramp: cool colours negative, warm
colours positive, and zero — the meaningful state on this chart (the
agonic line, the aclinic line, "no change") — still **glows** rather than
vanishing into the basemap.

This was redesigned twice on 2026-10-30, each time by **rendering the
real field** rather than judging swatches:

1. **The original was neon green** (#39ff14) with a pale-green and a
   yellow-green shoulder either side — "green on both sides of zero" —
   and because the ΔD plateau covered most of the globe, the wash looked
   like a green ball. That is the look the redesign was asked to fix.
2. **The first fix used an ice-white centre** (#a8fbff). It removed the
   green but came out *washed out*: half the map sits inside the
   plateau, and a pastel over half a map has no colour in it at all —
   the rendered D field was a pale sheet where the old green had at
   least been vivid.
3. **The shipped ramp keeps a saturated cyan centre** (#00e5ff, hue
   190° — the blue side of cyan, so it reads as aqua, not grass) with
   fully saturated wings. Zero still lights up on a dark basemap, the
   chart is a colour again, and `verify()` now fails any ramp carrying a
   **green-dominant** stop (`g > r and g > b`).

The **plateaus were narrowed** in the same pass (D ±10° → **±6°**, I ±5°
→ **±3°**, ΔD 6′/yr → **4′/yr**, ΔI 3′ → **2′/yr**, ΔF/ΔH 20 → **12
nT/yr**), because a wide flat band is the other half of what made the
wash monotonous: it spends half the map on one colour, so narrowing it
lets the gradient — and therefore the colour — show. Each ramp's shoulder
stop is clamped to `min(plateau·2.5, span·0.15)` so it can never land
outside the wing stop and need rescuing by the sort.

F and H are **magnitudes** (F 22,026–66,932 nT, H 100–41,887 nT) and take
a **sequential** ramp instead — indigo → violet → rose → amber → pale
yellow, a full sweep of warm colour with **no green across the middle of
the force charts** the way the old teal → lime → orange did. The low end
is a saturated indigo rather than near-black so a weak-field patch (the
South Atlantic Anomaly) stays visible against a night-lights basemap, and
the high end is bright enough to read as "strong". Stops are given as
*fractions* of the range and converted to absolute values in the worker,
so the browser interpolates in the field's own units without arithmetic of
its own — same reason the diverging plateau is fixed in absolute units.

### Blackout zones

Near each magnetic dip pole the horizontal intensity H collapses
toward zero, declination becomes undefined (a compass needle stands
vertical) and every isogonic line converges. NCEI's charts replace
those caps with a blank circle defined as **H < 2000 nT** (their own
error model: that is the Blackout Zone; 2000–6000 nT is the Caution
Zone). The worker computes the same mask, publishes it as `mask.bin`,
and has the probe report "Blackout zone" — the same blanks NOAA prints on
its own charts. Contour lines are cut at the mask boundary; a line that
merely clips the cap survives.

**The mask is applied per field, not globally** (`FIELDS_SPEC[k]["boz"]`).
Only **D** (undefined at the pole) and **ΔD** (it divides by H², so it
blows up with H) are blanked in the wash and excluded from their contours
and export bands. F, H, I and the other three rates are perfectly well
defined there — F is at its *strongest* at the poles and H merely runs
toward zero — so they are painted and exported normally. Blanketing them
would delete the poles from exactly the charts that show them best.

### Rebuild

```bash
python3 -m worker.magmap                # verify + compute + write
python3 -m worker.magmap --verify-only  # just the NOAA test-value gate
python3 -m worker.magmap --dry-run      # verify + compute, write nothing
python3 -m worker.magmap --fetch        # refresh the vendored WMM.COF first
python3 -m worker.magmap --time 2027.5  # evaluate at a decimal year
```

Outputs are deliberately **NOT .png** (Caddy serves every `*.png`
immutable for a year — the bug that hid the Köppen layer): the **eight
line sets** (index contours as in the table above, intermediates between
them), **eight Int16 grid planes** (per-field scale: 100 for D/I and the
angle rates → 0.01° / 0.01 arcmin/yr, 0.25 for F → 4 nT, 0.5 for H →
2 nT), `mask.bin` and `meta.json` all revalidate. The build takes ~10 s
and the published set is **2.9 MB** raw (was 1.1 MB for four fields);
Caddy's catch-all `encode zstd gzip` takes the GeoJSON down to roughly an
eighth of that on the wire, and the browser fetches **one** line family
at a time — whichever field is selected — plus the four planes of the
active mode, so a single view still costs what it used to.

### The hash-restore must register listeners before `addTo` (2026-10-28)

`MagLayer.init()` restores the previous choice from localStorage by
calling `state.lines.addTo(map)`. `addTo` fires `overlayadd`
**synchronously** — if the `overlayadd` listener is not yet attached,
the restore is invisible to `onLayerToggled`: `state.enabled` stays
false, `fillLines()` never runs, and the layer draws nothing while the
layers-control checkbox still looks checked (Leaflet only checks
`map.hasLayer`). That is the "checkbox on, field missing" bug.

Two app.js defects compounded it:

- The global `overlayadd` handler checked `e.name`, which Leaflet never
  sets (the event carries `e.layer`). Manually-checked overlays never
  entered `_activeOverlayNames`, so they fell out of the next hash
  rewrite.
- `applyLayersFromParsedHash` only recorded the name inside the
  `if (!map.hasLayer(...))` branch. If a module's init had already put
  the layer on the map from localStorage, the hash restore skipped both
  the `addTo` **and** the `_activeOverlayNames.add` — so the next
  rewrite dropped the overlay entirely.

The fix: `mag-layer.js` registers the `overlayadd`/`overlayremove`
listeners **before** the restore `addTo`; app.js reverse-looks the
layer name from `WEATHER_OVERLAYS` (`_overlayNameFor`) and records it
unconditionally. Pinned by three tests in `mag-layer.bun.test.js`
(listener-before-addTo order, `e.layer` not `e.name`, unconditional
name recording).

Pinned by `worker/tests/test_magmap.py` (the test-value gate,
relationship checks, encoding and the published artefacts — including the
eight fields, their per-field scales/ramps/boz flags, the sequential ramp,
the integer-step levels, the F/H contour spans and the published planes'
round-trip) and `public_html/tests/mag-layer.bun.test.js` (module
contract, the 4×2 selector, per-field masking/labels/ticks, export bands,
pane order, no-PNG rule, blackout masking, placement spot-check, and the
hash-restore order above) plus the mag sections of
`globe.bun.test.js` (one line layer + one wash, the meta-driven field set,
the switcher's persistence and generation guard).

## Human Transportation Overlay — NOAA "Anthropocene" (2026-10-28)

A single frozen world image: the Black Marble 2012 night-lights base
overlaid with the human footprint of global transport — **red** lines
for 87,000 daily airline flights, **blue** for the paths of 3,500
commercial vessels over a year (~10 % of global shipping traffic), and
**green** for the world road network used by 1B+ motor vehicles.

```
NOAA SOS ftp_mirror/…/anthropocene.png  (4096×2048, 16-bit, 31 MB)
        ↓  one-time conversion (Pillow/ffmpeg, no build pipeline)
public_html/data/transport/human-transportation.png
             (2048×1024, 8-bit, 522 KB — frozen, never regenerated)
        ↓  fetched once, cached forever
public_html/transport-layer.js  →  L.GridLayer, one drawImage per row
```

**Source:** NOAA Science On a Sphere, "Human Transportation"
(`sos.noaa.gov/catalog/datasets/human-transportation/`), NOAA NESDIS /
GSL — US Government work, public domain. The original ships as a 31 MB
16-bit PNG; we downsample to 2048×1024 8-bit because this is a
*decorative context layer*, not a probe-backed data grid — half
resolution is plenty, and PNG keeps the thin coloured route lines crisp
where JPEG would ring around them.

**Why a custom `L.GridLayer`, not `L.imageOverlay`.** An imageOverlay
spans exactly ONE copy of the world, so panning past the antimeridian
leaves a blank gap — the documented pitfall that shaped the temperature
layer. A GridLayer repeats, and because its tiles are Web Mercator
while the source is equirectangular, each tile row's latitude is
resolved through the **inverse Mercator** (`tileLat`) before picking its
source row; sampling in latitude-space instead would shift the routes
off the cities they connect. A tile straddling the world edge is drawn
as two `drawImage` blits, same as the temp layer.

**Why `.png` is fine here, unlike Köppen.** Caddy serves `*.png`
`immutable` for a year, which hid the rebuilt Köppen pyramid behind a
stale token (2026-10-22). That rule only bites *regenerated* assets —
this one is **frozen 2012 data that is never rebuilt**, so permanent
caching is exactly right.

The overlay never blocks map clicks (`blocksClick() => false`): it is a
picture, not a probe. Its pane sits at z-index **359** (above the
magnetic lines 358, below the isobars 360). Pinned by
`public_html/tests/transport-layer.bun.test.js` (16 tests: contract,
load order, single-tag, wrapping GridLayer, inverse-Mercator rows,
antimeridian wrap, async done(), setOpacity, listener-before-restore,
asset magic bytes and 2:1 aspect).

## Ocean Currents Overlay — NASA ECCO-2 (2026-10-28)

Sea-surface currents coloured by water temperature, from NASA's
**ECCO-2** ocean model (2021-2023) via NOAA SOS. The Gulf Stream,
Agulhas rings, Kuroshio and Antarctic Circumpolar Current read as
bright warm ribbons (~77 °F / 25 °C red) against a navy ocean of cold
water (~32 °F / 0 °C blue).

```
NOAA SOS ftp://public.sos.noaa.gov/oceans/perpetual_ocean/temp/
        perpetual_ocean_2048.mp4   (313 MB, 2048×1024, 120 s, 3601 frames)
        ↓  ONE-TIME frame extraction + edit (no build pipeline)
public_html/data/transport/ocean-currents.png
        (2048×1024, 255-colour palette PNG, ~336 KB — land transparent)
        ↓  fetched once, cached forever
public_html/ocean-layer.js  →  L.GridLayer, one drawImage per row
```

**This dataset ships ONLY as video** — unlike the Anthropocene layer
(which had a clean frozen still) and salinity (a 1,094-frame strip),
there is no still to hotlink. One frame is **extracted with ffmpeg**
and then edited four times, each step load-bearing (see AGENTS.md for
the exact operations):

1. **Land cut to transparency** with a Natural Earth 110m mask,
   dilated ~4 px so coarse coastlines leave no ocean-coloured fringe.
   The SOS frame bakes in opaque land, which would double up over our
   basemap — the exact reason salinity also replaced its black land.
2. **Polar caps blanked** (`|lat| > 78`): the source paints Arctic pack
   ice and Antarctic ice sheets as flat grey, which is not part of the
   ECCO sea-surface current field.
3. **Player chrome patched out**: the SOS export burns in a timestamp
   and frame counter. A clean row is copied over each corner — cropping
   would break the 2:1 aspect and shift every current against its coast.
4. **Warm current cores selectively saturated** so the Gulf Stream and
   friends pop against the navy without lifting the whole field.

Everything else follows the transportation/salinity rules verbatim:
`L.GridLayer` (never `imageOverlay`, which leaves a gap past the
antimeridian), `tileLat` inverse-Mercator per row, two blits at the
world edge, async `done()`, `setOpacity` on the subclass, `overlayadd`
registered before the localStorage restore, `blocksClick() => false`.

Pane is `oceanPane` (z-index **361** — above the isobars 360, below the
basins 362; it does not reuse 360, which the isobars already claim).
URL slugs: `ocean`, `ocean-currents`, `perpetual-ocean`, `ecco`,
`currents`. Pinned by `public_html/tests/ocean-layer.bun.test.js`
(17 tests) and `public_html/tests/overlay-contracts.bun.test.js`.

**Only ONE frame ships.** 313 MB of animation is not a browser asset;
the large-scale current structure is frame-invariant over the 120 s
loop. If animation is ever wanted, ship a thinned strip as a separate,
opt-in decision — do not start fetching frames per user.

## Story Tree — per-story relationships (2026-10-28)

`GET /api/pins/:id/tree` and `GET /api/events/:id/tree`. Clicking a pin
opens a ranked tree of what that story connects to:

```
● Harry Kane wins Ballon d'Or            [root event · 1,089 articles]
│
├─ ⬤ Same story · 1,088 other outlets    ← the event's own members
├─ ★ MOST RELATED          score ≥ 0.55
├─ ◐ RELATED               0.32 ≤ score < 0.55
└─ ○ LONG TAIL             score < 0.32   (collapsed, loads on expand)
```

Any child with its own connections gets a **▸ expand** button — clicking
it fetches `GET /api/events/:id/tree` and shows that story's connections
indented one level deeper. Results are cached per event so toggling is
instant. This is what makes it a tree and not just a list.

**Budget: 10 s per click.** Measured: 246–463 ms from click to painted
in a real browser, 20–180 ms warm, 84–970 ms for a never-cached pin. The
level query runs under `statement_timeout = 6000` and degrades to a
graph-only tree rather than hanging.

**The pin is an EVENT; the link graph is ARTICLE↔ARTICLE.** A pin is a
cluster of articles (median 1 member, p99 = 40, worst = 3,212). The old
`GET /api/links/:articleId` answered for ONE article of that cluster, so
it returned nothing for most pins — measured: a representative article
with **0 links** while its event carried **9,791**.

**The ranking must not trust `link_strength`.** 89 % of `ai_detected` rows
sit in [0.9, 1.0] and the relationship model returns `same_story` at 0.99
for articles about different countries. The score is
`0.70·semantic_cos + 0.20·keyword_containment + 0.10·link_strength×type`,
and `ai_detected` carries a **type weight of 0**.

**The seeds must be the clicked article.** A stale cluster can hold five
unrelated stories (840 of them hold 25 % of all event membership). One
event contained a router-bug article AND eight Ballon d'Or articles;
seeding from an arbitrary member returned the Ballon d'Or stories as
"most related" to a router story.

Full write-up: **`docs/STORY_TREE_2026-10-27.md`**.

## Hydrological Basins Overlay — FAO (2026-10-28)

The FAO **"major hydrological basins of the world"** (AQUASTAT / SOLAW),
CC BY-SA 4.0 — drainage boundaries delineated from hydrologically
corrected elevation data (WWF **HydroSHEDS** and Hydro1K) at 15
arc-seconds. `scripts/basin_build.py` turns the 139 MB shapefile into
`public_html/data/basins/basins.geojson` (6 MB raw / **1.4 MB gzipped**)
plus `meta.json`.

```bash
# The source is a download, not in the repo:
curl -L -o maps/bas_wrld_38047.zip \
  https://storage.googleapis.com/fao-maps-catalog-data/boundaries/bas_world_38047.zip
python3 scripts/basin_build.py            # dissolve → simplify → make valid → verify
```

**The published attribute table is NOT in the download.** The dataset
documents `MAJ_BAS / MAJ_NAME / MAJ_AREA / SUB_BAS / SUB_NAME / SUB_AREA
/ TO_BAS`, but the zip only carries `NAME_BASIN / GRID_CODE / AREA /
PERIMETER`, and the FAO WMS exposes nothing more (its second layer,
`basins_ws_38002`, only adds water-stress attributes). So the overlay
carries what the data actually has: the **235 FAO basin names** plus the
area **computed from the polygons**. No MAJ/SUB grouping is invented.

Three things the build has to get right:

- **Dissolve → simplify → make valid, in that order.** 50,225 polygons
  become 235; Douglas-Peucker at 0.05° becomes 6 MB; but Douglas-Peucker
  also creates bowties (121 of 235 features were invalid), so
  `ogr2ogr -makevalid -nlt MULTIPOLYGON` has to run afterwards — and
  `-makevalid` *without* `-nlt` silently writes an **empty file**.
- **The area formula needs radians.** `A = R²/2 · Σ Δλ_rad · (2 + sin φ_i
  + sin φ_{i+1})`. Degrees inflate the total by ~57×, so `verify()`
  bounds it at 40–200 M km² (the real answer is 147 M — essentially all
  of Earth's land).
- **The `-9999` sentinel is dropped.** 20,854 of the source polygons
  carry it: slivers in no named basin.

`verify()` is a gate: 15 known places must land in a plausible basin
(Amazon, Congo, Nile, Mississippi, Danube, Ganges, Murray, Ob, Yangtze,
Volga, Mekong, La Plata, Paris) — and the probe points must be INSIDE
the basin, because (31, 24) is the Sahara, not the Nile.

**The polygons are not interactive.** An interactive polygon swallows the
click and breaks the click-to-submit flow, so the pane is
`pointer-events: none` and the probe does its own ray-cast
point-in-polygon test.

**Colour schemes.** The legend carries three colour-dot buttons —
**blue** (default), **red**, **black** — that recolour the whole overlay
in place. The choice persists in `localStorage["xyzo.basinScheme"]` so
it survives reloads. Each scheme keeps the three hydrological classes
distinguishable by shade (river / coastal / interior).

## Facebook Friendships Overlay — NOAA SOS Explorer (2026-10-28)

Ten million Facebook friendship pairs plotted as a global arc map. From
the dataset's own note: the lines are *not* coastlines or borders — each
one is a real relationship. Africa reads dim (limited internet access)
and China reads dim (domestic platforms and restrictions).

```bash
# The source is a download (the NOAA FTP mirror):
curl -o maps/facebook_2048.png ftp://public.sos.noaa.gov/extras/facebook/2048.png
python3 scripts/facebook_build.py          # alpha from density → Mercator → XYZ
```

**The alpha IS the density.** The source PNG is 2048×1024 RGBA but is
**fully opaque** (alpha 255 everywhere) with a dark-blue background — the
**red channel** carries the friendship density: ocean ≈ 1, Sahara ≈ 1,
India ≈ 117, Western Europe ≈ 204, USA ≈ 250. The build maps
`alpha = red × 1.3` so the basemap shows through where nobody is and the
arcs glow where people are. Calibration:

| Place | source red | after ×1.3 |
|---|---|---|
| mid-Atlantic / central Pacific | 0–1 | 0–1 |
| Sahara / central Australia | 1–3 | 1–3 |
| Amazon (rainforest) | 2 | 2 |
| China | 1 | 1 (dim — as documented) |
| Japan | 106 | 137 |
| India | 117 | 152 |
| Nigeria | 134 | 174 |
| Brazil — **São Paulo** (coast) | 175 | 227 |
| Western Europe | 204 | 255 |
| United States | 250 | 255 |

**The Mercator inversion is per-pixel, not an imageOverlay stretch.** The
source is plate carrée (2:1). An `L.imageOverlay` over the whole world
would stretch that linearly across the *projected* Mercator rectangle,
distorting the poles. The build instead inverts Web Mercator for every
output pixel (`lat = arctan(sinh(π(1 − 2y/n)))`) and samples the source
at the matching lon/lat — nearest neighbour, matching the other raster
overlays.

**`verify()` runs twice, on purpose.** The source gate runs before any
tile is written (a flipped axis or a broken density channel must not
reach the pyramid); the tile gate runs afterwards (an inverted Mercator
passes the source gate and only shows up in the tiles). Both probe 13
known places — including the Amazon, which catches a Brazil probe that
was accidentally pointed at the rainforest instead of São Paulo.

`maps/facebook_2048.png` is 2.9 MB; the pyramid is **1,365 tiles / 17 MB
raw** at z0–z5 (z0–z5 is the useful range: the source is 2048 px wide,
so z5 is already 4× upsampling).

## World Languages Overlay — Glottolog (2026-10-29)

**🌍 Languages** — 8,889 language points from
[Glottolog](https://glottolog.org/meta/downloads) (Max Planck Institute
for Geoanthropology, **CC BY-SA 4.0**), the free authoritative database
of the world's languages.

```bash
curl -o maps/glottolog_languages_geo.csv \
  https://cdstar.eva.mpg.de/bitstreams/EAEA0-608B-9919-A962-0/languages_and_dialects_geo.csv
python3 scripts/languages_build.py
```

**POINTS, NOT POLYGONS — and that is the point.** The previous overlay
drew one polygon per language area (Native Land Digital, 1,473). A
polygon can only ever show **one** language: where several share a
territory — Papua New Guinea, the Amazon, the Caucasus, much of Africa
— the topmost polygon hides the rest. Points overlap, so a cluster
reads as "many languages here" and the **probe lists every language
under the cursor**. In the Papua New Guinea highlands the probe finds
675 languages inside a 4° box.

Glottolog also reaches languages the Indigenous-territories dataset
does not: **Aasax, Wintu, Ainu, Yaghan**, thousands of others, plus 585
dialects. 8,889 points against 1,473 polygons.

| | polygons (old) | **points (now)** |
|---|---|---|
| languages | 1,473 | **8,889** |
| co-spoken in one place | hidden | listed by the probe |
| rare / extinct | mostly absent | Aasax, Yaghan, Ainu, Wintu |
| rendering | SVG fill | **canvas** (8,889 points is a lot of DOM) |

**Dot size = how many languages share a spot.** `radius =
2.5 + min(6, log₂(n) × 1.6)` — one language is a dot, nine is a stack.
Colour comes from Glottolog's **macroarea** (Africa, Papunesia, Eurasia,
North America, South America, Australia), so a colour reads as a region
rather than a random per-language id.

`verify()` probes six known languages in their known places (Basque,
Ainu, Aasax, Sámi, Yaghan, Wintu) and refuses to publish below 8,000
languages. A flipped axis puts every one of them in the wrong ocean.

Pane is `langPane` (z-index **358** — above lightning 356, below mag
358/rivers 365). `public_html/languages-layer.js` loads BEFORE
`app.js` and is in `bump_frontend.sh`'s `ASSETS`. The probe owns the
click while armed (`blocksClick()` → app.js's click-to-submit guard).

**One layers-control entry** (`🌍 Languages`) with the standard opacity
slider. URL slugs: `languages`.

## The Offline / Tile Notice — and its X (2026-11-04)

The notice that says **"Map imagery isn't loading"** sits across the
**top of the map**. It is a NOTICE, not a blocker — nothing on the page
depends on it — so it now carries an **X**.

**Dismissing it must also stop it coming back.** The tile watcher fires
on **every failed batch of tiles**, so a dismissed banner that
reappeared ten seconds later would be worse than no button at all:

| | |
|---|---|
| dismissed | remembered in `sessionStorage["xyzo.offlineNoticeDismissed"]` — a reload in the same tab keeps it |
| forgotten | as soon as the situation **RESOLVES**: the tiles come back, the connection returns, or (for the boot notice) the map appears — so a genuinely **new** outage warns again |

**A BOOT DISMISSAL IS NOT FORGOTTEN BY SOMETHING ELSE RECOVERING.**
`clearDismissal()` now refuses to run while a boot dismissal stands,
because `sync()` — called from `load` and from every `online` event —
clears the flag as soon as the connection looks fine, and the 45 s
backstop would then have handed a dismissed notice back on a page whose
map was never coming up. Only the map **appearing** (`healBoot`) forgets
it. One guard in `clearDismissal()` covers every recovery path instead
of three call sites.

**Three wordings, one notice**: "Map imagery isn't loading…", "You're
offline…" and **"The map didn't load."** (below). The button is a real
`<button>` with an accessible name, and it grows to the 44 px touch
target on a coarse pointer.

**Run the audit**

```bash
python3 scripts/offline_notice_audit.py
```

It forces the condition the notice reports, checks that the notice
appears with its X, clicks it, and checks that it **stays** gone after
another failed tile batch.

**THE TRAP THE AUDIT WALKED INTO — AND WHY IT IS WRITTEN DOWN**

The route must be on the **CONTEXT**, not the page. The **service
worker takes control of the page** (`clients.claim`) and serves the
tiles itself — and a request made **by the worker** does not go
through a page route. So 20 of the 24 tiles reached the real network,
**loaded**, and the page saw only **four** failures instead of the
twenty a real outage produces. Four is below the watcher's threshold of
eight, so the notice never appeared and the audit reported "no button"
for a notice that was working perfectly.

## "The map didn't load." — the notice for a dead app (2026-11-06)

Owner ask: *"is there something we can do if we detect the map isn't
loading correctly to allow users to do a 'hard refresh' and just have
them click on something to help them… like a popup that's closable and
they can opt out for if needed"*.

Most of it already existed — the top notice had the ✕, the remembered
opt-out and the **Reload fresh** button. **What was missing was the
DETECTION**: the notice only ever fired on a dead connection or on
failing basemap *tiles*, never on **app.js itself** failing (a 500, a
throw on line 1, a deploy that landed without bumping `?v=`). Those are
exactly the states where a hard refresh is the fix — and they were the
one case where the fix was unusable:

| | |
|---|---|
| **the offer** | the same top notice, third wording: **"The map didn't load."** with **Reload fresh** and the ✕. No new modal, no second notice system. |
| **the trigger** | **only on real evidence the map is not working** — `window._xyzoMap` absent after `DOMContentLoaded` + a 2 s grace, or a same-origin parser `<script>` failing. The `· new version` badge is untouched: raising this on every deploy would train people to dismiss it unread, and a mid-session deploy is fixed by a *normal* refresh (`index.html` is `no-cache`). |
| **why `hardRefresh()` MOVED to `offline.js`** | it was a module-level function in `app.js`, exported as `window.hardRefresh`. When app.js is what failed, that export **does not exist**, so the button degraded to `location.reload()` — which cannot bypass the `immutable` year-long cache and would have changed nothing. `offline.js` loads at index.html line 708, **before** app.js at 843, and `app.js` now calls `window.hardRefresh()` instead of defining its own copy (a test asserts there is only one). |
| **the hash survives** | `location.reload()`, never `location.replace()` — the hash IS the map's state (`#lat,lng,zoom/overlay=…`). |

**THE SIGNAL, AND WHY IT IS EXACT.** `window._xyzoMap` is assigned at
app.js's **top level** the moment `L.map("map")` is constructed (about
40 lines in, not inside a callback) and is never cleared. app.js is
`defer`, so `DOMContentLoaded` fires only once **every** deferred script
has run or failed — post-DCL absence is therefore a verdict, not a
timing guess. `mapIsUp()` requires both `_xyzoMap` **and** `#map`, so a
page with no map can never be told its map failed to load.

**MEASURED, not assumed** (Playwright against the live site, fresh
context each run):

| scenario | banner | notes |
|---|---|---|
| healthy load | **never** (18 s watched) | `_xyzoMap` set, 0 page errors |
| `app.js` blocked (HTTP abort) | **4.74 s** | DCL 4.37 s → the *fast path*, because the failure resolved after `offline.js` ran |
| `app.js` returns 200 and throws | **5.88 s** | DCL 3.74 s + the 2 s grace — a normal load, no error event |
| optional lazy chunk missing | **never** | `help-me-chat.js` is `async`, filtered out; map came up |
| **`app.js` delayed 8 s by the network** | **never** (was a false alarm) | DCL 8.65 s, map up — see the trap below |
| notice pressed, `app.js` still dead | **navigates** | `window.hardRefresh` is a function even with app.js blocked |
| `_xyzoMap` appears after the notice | **gone in < 2 s** | `healBoot()` retires it and forgets the dismissal |
| ✕ pressed, then `sync()` / reload | **stays gone**, key `'1'` | see the dismissal guard above |

**THE TRAP: `readyState` IS ALREADY `"interactive"` INSIDE A DEFER
SCRIPT.** It flips to `interactive` *before* deferred scripts execute
(`DOMContentLoaded` fires *after* them), so the first version branched on
`if (document.readyState === "loading")` and, finding it false, scheduled
the probe 6 s after **`offline.js`** rather than after **app.js** had its
chance. Measured: with app.js delayed 8 s by the network it raised
**"The map didn't load." at 6.8 s over a map that then appeared** — a
false alarm on a merely slow connection, which is the one thing this must
never do. The probe is now registered on `DOMContentLoaded`
**unconditionally** (safe: this file is a defer script, so that event has
not fired yet), and a test asserts `watchBoot()` contains no `readyState`
branch at all.

**BACKSTOP.** `setTimeout(probeBoot, 45000)` from `offline.js`, for a
script that never finishes — an infinite loop in a defer script blocks
`DOMContentLoaded` entirely, so the normal probe never runs. 45 s clears
the measured worst healthy case (the whole defer payload is **703 KB
gzipped**: ~7 s at 100 KB/s, and all of it is *inside* the DCL wait, not
the grace period). A false alarm at 45 s is self-correcting anyway: the
2 s interval calls `healBoot()` and the notice goes the moment the map
appears.

**PRECEDENCE**, same order the tile notice already used: offline
outranks everything; a missing map outranks missing imagery (otherwise
`tileTick` repaints its wording over ours every ten seconds). One claim
on screen at a time — the notice still suppresses the API-health banner,
and lets it speak again when it goes.

**Verified** with Playwright (the four scenarios above plus the timing
table) and pinned by **`public_html/tests/map-failed-notice.bun.test.js`
(28)**; `hard-refresh.bun.test.js` now reads `offline.js` for the
primitive and asserts the **script order** (`offline.js` before `app.js`,
both `defer`), and `offline-notice-dismiss.bun.test.js` asserts app.js no
longer carries a second copy.

## Why We Made It — the story of one of the three maps (2026-11-12)

The about page now carries the origin story, in the founder's words and
in the page's own voice. The short version:

- **He read a map of the world in the ground.** Standing at Grand
  Prismatic Spring, the concentric mineral bands looked like what they
  resemble — Antarctica at the centre, the north pole at the rim, a green
  patch for Greenland — and the thing that struck him was not the
  resemblance but the **obviousness**: it was right there, under his
  feet, and it was not printed on anything.
- **Rule one: a map that can change.** The spring is not a picture of a
  map; it is a map *being made*, and it is different tomorrow. That is
  the project's whole idea — a map of the world that is not a drawing of
  the world but **the world, right now, changing**. It is also why the
  photographs are not published as stills (the thing they show changes
  with the water, so a fixed image would be a lie within a day) — and
  why the site now keeps **a year of the world's weather maps** (the
  ⚙ menu's TIME MACHINE): the map of the past is a lookup, not a
  memory.
- **Rule two: be careful where you bring electronics.** A geyser does
  not consent to being photographed, and a publisher does not consent to
  being crawled. XYZO is a machine that reads the world, and it is held
  to the same courtesy the founder set himself: read what is open to
  you, go slowly, and do not take more than you need.
- **The three maps, grounded in what the site actually has:** the
  **ground** you are standing on, the **globe** (the 🌐 button on the
  zoom bar), and the **web** of connections (the story tree). The site
  is the third.
- **The honest answer to "do we now have THE MAP?"** — not the map of
  the universe; nobody has that, and anyone who says they do is selling
  something. But the map of *today*: every story, every place, every
  connection, free and open and updating while you watch.

**THE EDITORIAL RULE, PINNED BY A TEST:** the account is **attributed,
never asserted as fact** — the founder's words are carried as his words,
and the private parts of the story are not published (a public page is
not the place for someone's worst night; the map is the part that
belongs to everyone).

Tests: `public_html/tests/about-why.bun.test.js` (6).

## A Pin Tells You Where It Is (2026-11-12)

Owner ask: *"when you click on a point.. can you have it show the details
of that point including the google popup map showing the satellite view
for example lat/lng and anything else a user might want to know about
that point... nearest town nearest news... if that takes too long dont do
it.. just show something so they can see at least the lat/lng and a few
other things that are fast for us to provide"*.

**EVERYTHING HERE IS ALREADY IN HAND — no request, no wait.** The pin
carries its own coordinates, its place, its source and its time:

- **the coordinates** — `📍 48.85771° N · 2.34884° E`, in a monospaced
  line under the title;
- **the nearest town** — the place badge the popup already had;
- **the nearest news** — the "Related Stories" section the popup already
  had (the event's other articles);
- **the satellite view** — a **📡 button**, not an embedded map: it is a
  NESTED Leaflet map (a second map to build, four Esri tiles to fetch), so
  opening it automatically would make every pin tap wait for a picture of
  a field — which is exactly the *"if that takes too long dont do it"*.
  Clicked, it opens the existing satellite popup (the mini-map plus the
  Google and Bing satellite links);
- **📋** copies the coordinates.

**TWO TRAPS, BOTH MEASURED.**

1. **THE POPUP'S CONTENT IS 914 px LONG IN A 380 px SCROLL BOX** (and the
   content wrapper carries a CSS `zoom: 1.15`), so anything placed low
   in the popup is **below the fold** — and **clipped content is not
   hit-tested**, so a button down there is invisible AND dead. The first
   version put the satellite button in a block at the bottom of the
   popup and it did *nothing at all*. The numbers and the buttons
   therefore live in the **header row**, which is always visible, and
   the content box was given the room the extra row needs (`maxHeight`
   380 → **440**) so the EXISTING actions (view, Fix, Report…) stay
   visible too.
2. **THE LISTENERS ARE DELEGATED FROM THE POPUP ELEMENT, NOT BOUND TO
   THE BUTTONS** — the same rule the close button follows (see
   `attachPopupClose`): the popup's content is a FUNCTION, so Leaflet
   rebuilds it (`setContent`) and the buttons are replaced by brand-new
   nodes; a listener bound to a button dies with the old one.

**MEASURED LIVE** (Playwright, a desktop and a 393×852 phone): the 📡
button opens the satellite popup with **4 Esri tiles** on both, the ✕ and
the existing actions still work, **0 page errors**.

Tests: `public_html/tests/popup-point-details.bun.test.js` (5).

## The Scale Bar — how far is this? (2026-11-12)

Owner ask: *"can you show a distance measure on the map for all the maps
i dont see it is it hiding under the 'help me' tab? its nice to know
distance based on the zoom level"*.

**THERE WAS NOTHING TO HIDE.** The 3D globe has carried a scale since it
was written (`maplibregl.ScaleControl`); the **flat map had none** —
`L.control.scale` was never called — so the corner the reader was looking
in was empty.

**IT IS IN THE BOTTOM LEFT**, and the reason is the corner census of the
flat map:

| Corner | What is in it |
|---|---|
| top left | the zoom bar (+, −, 🌐) |
| top right | the layers dropdown |
| bottom right | the **"Help me" pill** (fixed, z-index 9998) + Leaflet's attribution |
| **bottom left** | **nothing** — so the scale lives here |

**IT FOLLOWS THE ZOOM** (measured live): "2000 km" at zoom 2, "10 km" at
zoom 10, "3 km" at zoom 12.

**ON A PHONE IT CLEARS THE BOTTOM BAR**, which spans the width: the bar's
top edge is **measured** (`--bottom-bar-top`), and the rule that does it
must carry **the same selector as Leaflet's own** — the vendored
stylesheet sets `.leaflet-bottom .leaflet-control-scale { margin-bottom:
5px }`, and a lower-specificity rule simply loses (measured: the bar sat
at the very bottom, under the bottom bar — the same "where did it go?"
as not having one). It also sits **under** the live panel (z-index 350
against the panel's 400) so it never floats over a panel that is reading
the news.

**BOTH VIEWS WEAR THE HOUSE LOOK** — a dark pill, a light rule, the
number in the map's own type — because MapLibre's default is a bright
white box in the corner of a dark globe (and its rule colour is set
inline, so the override needs `!important`).

**METRIC ONLY**, like the globe's: the site is international, and
"both" is two numbers and two rules for one bar.

Tests: `public_html/tests/map-scale-bar.bun.test.js` (4).

## The Mouse Pointer — one ring, and no canvas that eats the map (2026-11-04)

`scripts/hover_audit.py` is the **Playwright study of the pointer**. It
moves the mouse the way a reader does, in steps, onto real features and
reads back what the page did.

**WHAT IT MEASURES**

| | the ring | the card | the cursor |
|---|---|---|---|
| a story pin | ✓ 24 px | ✓ title · place · age | ✓ `pointer` |
| an earthquake | ✓ 26 px | ✓ magnitude · place · age · depth | ✓ `pointer` |
| open water | — | — | ✓ back to the default |
| the globe's pins | ✓ | — | ✓ `pointer` |

**THE FOUR FAULTS IT FOUND**

1. **A Leaflet canvas renderer was swallowing every pointer event on
   the map.** `L.canvas()` puts its container in the **default overlay
   pane** — which is where the **story-pin canvas** lives. The
   renderer was therefore appended *after* the pin canvas and sat **on
   top of it**, and a canvas is a full-map element with
   `pointer-events: auto`. **The story pins' hover died the moment the
   earthquakes or the language points were switched on.** The fix:
   name the pane — `L.canvas({ padding: 0.3, pane: PANE })` — and the
   pane's CSS is `pointer-events: none`, so it paints and is invisible
   to the pointer.

2. **The ring was the pin renderer's private element.** The
   earthquakes, the faults and the language regions had **no ring**:
   pointing at one showed nothing, so the reader could not tell that
   the dot under the cursor was an earthquake. There is now **ONE**
   ring — `public_html/hover-ring.js` — and every point overlay asks it
   to move. One element means one circle: two elements would mean two
   circles could be on screen at once, and a query for
   `.xyzo-pin-hover-ghost` could find the wrong one.

3. **The hover card only knew about story pins.** It now takes a
   **generic target** from any layer (`HoverInfo.setTarget`), so the
   default "pins" mode says what is under the cursor whether it is a
   story or an earthquake.

4. **The globe had no ring**, and its first attempt used a map-wide
   `queryRenderedFeatures` — which **does not report the features under
   the cursor on a sphere**. It uses the **layer's own** `mousemove`.

Plus two smaller ones: the earthquake's age printed **"20761 d ago"**
(the epoch rather than the age — `relativeAge()` takes an age in ms and
was handed the timestamp), and the cursor stayed a **pointer** after
the pointer left the canvas.

**THE TRAP THIS STUDY WALKED INTO — AND WHY IT IS WRITTEN DOWN**

The first version of the audit reported the hover as *completely
broken*. It was wrong. It picked the **first pin the API returned**, and
that pin was often **under the layers dropdown** — so the pointer moved
onto the dropdown, not onto the map, and the map never saw a mousemove.

**A hover study must only count a point the pointer can REACH.** The
audit asks `document.elementFromPoint()` what is really under the
cursor before it counts anything. (It is also how the dropdown
covering the map was found: a reader aiming at a pin in the top-right
corner is aiming at the dropdown.)

**Run it**

```bash
python3 scripts/hover_audit.py            # the flat map
python3 scripts/hover_audit.py --globe    # the 3D globe
```

## Earthquake Overlay — USGS ComCat (2026-11-04)

**Source:** USGS Earthquake Hazards Program, the GeoJSON "summary"
feeds — <https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/>.
Public domain (US Government work); the attribution is carried in
`meta.json` and printed on the map.

**Why a copy and not the live feed.** The USGS refreshes its feeds every
minute and they need no key, no account and no rate limit — which is
exactly why the browser must not be the one asking. `scripts/earthquake_build.py`
downloads the four feeds and publishes them under
`public_html/data/earthquakes/`:

| File | Window | Typical size |
|---|---|---|
| `hour.geojson` | the last hour | a handful of events |
| `day.geojson` | the last 24 hours | ~200 events |
| `week.geojson` | the last 7 days | ~2,000 events |
| `month.geojson` | the last 30 days | ~10,000 events |

The client fetches only the window the reader asked for, so the "last
hour" file stays small instead of dragging the whole month with it.

**The encoding.** The circle's **radius grows with the magnitude**
(3 px at M1, 11 px at M4, 18 px at M6 and above) and its **colour
cools with the age**:

| Age | Colour |
|---|---|
| under an hour | `#ff2d2d` red |
| under a day | `#ff7a1a` orange |
| under a week | `#ffd21f` yellow |
| under a month | `#4aa3ff` blue |
| older | `#8b9bb4` grey |

The popup carries the magnitude, the place, the time in UTC **and** in
the reader's own timezone, the depth, the felt reports, the tsunami
flag and the USGS event id — with an **"Open ↗"** link to
`https://earthquake.usgs.gov/earthquakes/eventpage/<id>/executive`.

**Rebuild**

```bash
python3 scripts/earthquake_build.py          # ~30 s (the month feed is 7 MB)
python3 scripts/earthquake_build.py --verify-only
```

**Timer:** `xyzo-earthquakes.timer`, every 10 minutes
(`sudo systemctl start xyzo-earthquakes.service` for a one-off).

---

## Tectonic Faults Overlay — USGS (2026-11-04)

**Source:** the USGS **Quaternary Fault and Fold Database** (the faults
and folds of the United States that are believed to be sources of M>6
earthquakes) and the USGS **global plate boundaries**, taken from the
KML layers on the USGS Earthquake Hazards KML page. Public domain (US
Government work).

`scripts/faults_build.py` parses the KML (it is a ZIP containing
LineString placemarks) into **33,926 features** under
`public_html/data/faults/faults.geojson` plus a `meta.json`. The lines
are coloured by kind (plate interface vs fault trace) and by the age of
the movement, and the most significant faults are drawn first so a
world view is not a hairball.

**The trap:** the coordinates are easy to get backwards, and a swap puts
the San Andreas in the sea east of Japan — where it still looks like a
line. `verify()` therefore probes the **San Andreas** and the **Hayward**
fault, and refuses to publish without them.

**Rebuild**

```bash
python3 scripts/faults_build.py
```

---

## Ocean Currents (live) — OSCAR (2026-11-04)

**Source:** **OSCAR** (Ocean Surface Current Analyses Real-time), ESR /
NASA PO.DAAC, served through **NOAA CoastWatch's ERDDAP** — public
domain, no key, no account, no login.

**A picture cannot show flow.** The existing `🌊 Ocean Currents (ECCO)`
overlay is one frozen frame of the NOAA SOS "Perpetual Ocean" field:
it shows where the warm water is, but it carries no direction, so it
cannot show a current running. The **live** overlay publishes the
**direction** instead.

`scripts/ocean_currents_build.py` downloads the newest OSCAR five-day
composite and publishes a 1° planar grid:

**THE COMPOSITE IS FROM 26 SEPTEMBER 2014, AND NOTHING CHECKED.**
The ERDDAP that serves OSCAR (`coastwatch.pfeg.noaa.gov/erddap/files/
jplOscar/`) was loaded in **February 2015**. Its newest file is
`oscar_vel8026.nc.gz`, and the number in the name is the composite's
**day count since 1992-10-05** — `8026` is **2014-09-26**, and the
file's own `PERIOD` attribute reads `Sep.26,2014` and its `time`
variable reads `8026`. There are **117 files** in the mirror
(`oscar_vel7001` … `oscar_vel8026` = 2011-12-06 → 2014-09-26), the
listing is **not paginated**, and there is **no newer name** — so the
daily timer had been re-publishing the same twelve-year-old field since
the overlay shipped. The physics gates all passed it: **no gate ever
looked at the DATE.**

`verify()` now has a **FRESHNESS GATE**, and it is the gate that
matters most:

```python
MAX_AGE_DAYS = 45
…
check(STALE_PROBLEM, age is not None and age <= MAX_AGE_DAYS, …)
```

A composite older than 45 days is **refused**: the grid on disk is
left alone and the build exits non-zero, so `xyzo-ocean-currents.timer`
alarms every day until a fresh source is configured. The **META is
still refreshed** when the published grid *is* that field (a meta that
describes a grid that is not the published one would be a lie), and it
carries `source_date`, `source_age_days` and the measured
`coastal_coverage`.

**THE CURRENTS STOP SHORT OF THE COAST — AND IT IS THE SOURCE.**
Owner report: *"did you notice that the Ocean currents (live) stop
just off the coast of africa?"* The answer is the **altimetry mask**:
OSCAR's surface velocity is derived from satellite altimetry, and
altimetry has no valid solution in shallow, river-influenced water.
The northern Gulf of Guinea (the Bight of Benin) is exactly that kind
of water, so the product leaves it empty and the currents stop at
**6°N**. This was **not** the build dropping cells:

- the published 1° grid was compared **cell-for-cell** against the raw
  1/3° NetCDF — **0 value mismatches** above 0.02 m/s, and the 139
  cells that differ are values below 0.005 m/s rounding to zero;
- at 1/3° the same box is empty: `u` **and** `v` are both NaN north of
  6°N, and the alternate `um`/`vm` ("maximum mask") fields fill only
  4,110 cells globally and **none** of them here;
- the **daily NOAA CoastWatch geostrophic product**
  (`nesdisSSH1day`, 2026-09-28) was fetched and measured and its Gulf
  of Guinea coverage is **cell-for-cell identical**.

So every altimetry-based surface-current product carries the same
hole, and no client-side work fills it. The legend now says so, and
the measured coverage (44.6 % of the Gulf of Guinea box) is published
in `meta.json` rather than left as an impression.

**A FRESHER SOURCE WAS MEASURED AND REJECTED.** The daily
`nesdisSSH1day` field is **37 days old** and needs no credentials —
but its **absolute** geostrophic velocity blows up near the equator
(the `g/|f|` term against a zonal MDT gradient). Measured zonal-mean
`u` over 120–170°W:

| latitude | OSCAR (published) | daily SSH geostrophic |
|---|---|---|
| 5°S | **−0.368 m/s** (westward — the South Equatorial Current) | **+0.143 m/s** (eastward — wrong) |
| 0° | −0.215 m/s | +0.495 m/s |
| 5°N | +0.108 m/s (the counter-current) | +0.688 m/s |

Swapping it in would have traded a **visible** coastal hole for an
**invisible** equatorial error — a field that flows the wrong way
across the whole tropical Pacific. It is recorded here so the next
session does not re-propose it.

**WHAT WOULD ACTUALLY FIX IT.** OSCAR **v2.0** (0.25°, daily, with
`final` / `interim` / `nrt` quality levels) is the current product and
it keeps the diagnostic model, so its tropical physics are right. It
lives on **NASA PO.DAAC** (a free **Earthdata** account) and on the
**University of Hamburg's ICDC** mirror (registration; its THREDDS
returns **HTTP 401** from this box). Neither is reachable without a
credential — which is why the freshness gate is the honest interim
answer rather than a switch.

**TOOLS.** `scripts/ocean_current_audit.py --browser firefox` drives
the layer through **eight** scenarios (preset, link, checkbox, pan,
**background tab**, probe, arrows, and **the legend telling the
truth**) and reads the state back out of the page.
`scripts/ocean_current_shots.py` takes the two pictures that answer the
owner's report: the map at the reported view with the dropdown closed,
and the legend cropped.

```
public_html/data/ocean/grid.bin     Int16, planar: u in [0, n), v in [n, 2n),
                                    0.01 m/s per unit
public_html/data/ocean/meta.json    grid layout, range, attribution, licence
```

`public_html/ocean-current-layer.js` then advects particles along that
pair, with **the wind layer's physics** (longitude wraps, the column
past the last one wraps, `cos(lat)` shortens a degree of longitude, the
trail is trimmed by length, `schedule()` runs from `finally`, the canvas
is re-anchored on every pan).

### The Firefox freeze (2026-11-04)

Owner ask: *"can you check that firefox works with the Ocean currents
(live) — we might be having an issue."*

**The layer was fine. The TAB was not.**

`step()` returned early on `document.hidden` **before** the `finally`
that re-schedules the frame:

```js
function step(now) {
  state.raf = 0;
  if (!state.enabled) return;
  if (document.hidden) { state.lastT = 0; return; }   // ← no schedule()
  try { … } finally { schedule(); }
}
```

so the frame chain was never re-armed — **and nothing else ever
re-armed it**. **Firefox KEEPS FIRING `requestAnimationFrame` in a
background tab (throttled to about 1 Hz) where Chrome SUSPENDS it.**
In Firefox the first background frame ran, hit that branch, and the
animation was **dead for good**: the reader switched tabs, came back,
and the currents were frozen. Chrome never saw it, because its
suspended rAF means `step()` never runs at all while the tab is
hidden — the same code, a different browser's scheduling.

The wind layer has had the guard and a `visibilitychange` handler since
2026-10-29; this layer was written later and missed both. It now has
the same shape: `schedule()` refuses to hold a frame while the tab is
hidden, `pause()` releases the pending one without disabling the
layer, and a `visibilitychange` handler **restarts** the chain when the
tab is seen again. **`globe-wind.js` — the globe's engine, which serves
the globe's wind AND its ocean currents — had the identical shape** and
is fixed the same way.

### Three dead controls, found on the way

The layer shipped a **legend** — the speed key, a **Probe** button and
the **Streamlines / Arrows** chips — and `mountLegend()` was written
and exported. **Nothing ever called it.** So the reader had no legend
at all: no speed key, and the two controls that live in it were not on
the page. (The CSS for the legend has been in `styles.css` since the
layer landed.)

And even if the legend had been mounted, both controls were dead:

| Control | What it did | Now |
|---|---|---|
| **Probe** | `showProbe()` was defined and **never called from anywhere** — arming it did nothing at all | Wired to Leaflet's own `mousemove`/`click`, so it reads `e.latlng` (never `offsetX`, which is 300 px out on the pin canvas). It positions the card at the cursor and **owns the click while armed** — app.js's click-to-submit guard checks `blocksClick()`, exactly like the temperature and magnetic probes. The armed state is remembered |
| **Arrows** | Nothing ever read `state.style`, so the chip changed the button and **not the map** | A real renderer: one glyph per 46 px cell, the shaft's **length** carrying the speed and its **head** the direction, coloured by the published ramp. The cut-off is **0.02 m/s**, not the wind layer's 0.2 — the median ocean surface current is **0.11 m/s**, so a wind-style threshold would leave the whole ocean blank |
| **The legend itself** | Never mounted | Mounted into the layers dropdown, retried until the control exists (app.js creates it *after* this module initialises) and re-mounted when the grid arrives, so the speed key is built from the **published** ramp |

### Measured

`scripts/ocean_current_audit.py --browser firefox` (seven scenarios:
preset, shared link, checkbox, pan, **background tab**, probe, arrows)
— **all seven pass in Firefox and in Chromium**, no console errors.
The flat map itself was verified in Firefox at **1280×860 and 393×660**,
from a preset, a link and a checkbox, with the service worker active,
on a cold cache with a slow network: the layer loads, animates at
**40-60 fps** and draws. `verify()` was re-run against the published
grid: **8/8 pass** — the field is physically correct.

**Known caveat — the vintage.** NOAA CoastWatch's OSCAR mirror stops at
the **2014-09-26** composite; the NRT product is behind a NASA
Earthdata login and the University of Hamburg's copy is restricted to
institutional users. The global structure of the currents (the Gulf
Stream path, the Antarctic Circumpolar Current, the equatorial currents)
is unchanged, and the overlay says so in its legend — but it is a
2014 field, and `meta.json` records the composite's own period. **If a
NASA Earthdata token is configured, the build can be pointed at the NRT
product** and the overlay becomes genuinely current.

**Rebuild**

```bash
python3 scripts/ocean_currents_build.py
```

**Audit**

```bash
python3 scripts/ocean_current_audit.py --browser firefox
python3 scripts/ocean_current_audit.py --browser chromium
```

**Timer:** `xyzo-ocean-currents.timer`, daily.

---

## Language Regions Overlay — Glottolog × Natural Earth (2026-11-04)

**Sources:** Glottolog (Max Planck Institute for Geoanthropology,
**CC BY-SA 4.0**) and Natural Earth 50 m admin-0 countries (**public
domain**).

The point layer (`🌍 Languages`) answers *where* a language is spoken;
the **region** layer (`🌍 Language regions`) answers *which languages
are spoken in a place*. `scripts/languages_regions_build.py` joins
Glottolog's **9,094 languoids that carry a territory** against Natural
Earth's country polygons and publishes **234 regions**, each carrying
its languages, how many, and the dominant Glottolog macroarea.

The polygons are drawn as a wash coloured by the language count, and
the probe lists the languages of the region under the cursor. The
polygons are **not interactive** and the pane ignores pointer events,
so they never swallow a map click.

**Rebuild**

```bash
python3 scripts/languages_regions_build.py
```

---

## 3D Globe View — MapLibre (2026-10-28)

`/globe` is a **separate** 3D globe. The flat map is Leaflet and
stays Leaflet — the canvas pin renderer, the isobar layer, the basins
probe and the layers dropdown are all deeply Leaflet-coupled, so the
globe is additive, not a port.

MapLibre GL JS 5.6 is vendored at `public_html/vendor/maplibre-gl/`
(939 KB raw / **248 KB gzipped**) and is loaded **only by the globe
page** — the flat map never pays for it. The globe carries the same
overlays as the flat map:

| Overlay | How it renders on the globe |
|---|---|
| Köppen, Soil (9 properties + switcher), Cropland, Land Cover | Web Mercator raster pyramids, warped by the globe |
| Geology (Macrostrat) | external XYZ tiles (`tiles.macrostrat.org`) |
| NASA Satellite / Rain / Night | external GIBS XYZ tiles, date baked at load |
| Rivers, Hydrological Basins, Magnetic lines | GeoJSON, reprojected natively |
| Isobars | fetched once from `/api/weather/isobars`, coloured by level |
| Temperature | the GFS grid baked into an equirectangular canvas, draped as a MapLibre image source |
| Pins | same `/api/pins/map` call, capped at 2,000 |

**Two flat-map overlays deliberately do NOT port:**
- **Wind streamlines** — the animation is a screen-space canvas tied to
  Leaflet's 2D projection; particles behind the globe have no
  meaningful screen position.
- **Geologic contacts (USGS)** — the layer is WMS (BBOX/GetMap), and
  MapLibre raster sources need an XYZ `{z}/{x}/{y}` template.

**The temperature image source must stay OFF the exact poles.**
Projecting ±90° onto the globe yields `y=Infinity` ("x=0, y=Infinity,
z=0 outside of bounds") and the source silently never renders. The
corners are inset to ±89.5° — half a grid cell, invisible, but it
keeps the projection finite.

Two MapLibre 5.6 traps:

- **The constructor's `projection` option is IGNORED.** `getProjection()`
  stays `null` and the map silently renders flat. The globe has to be
  set with `map.setProjection({type: "globe"})` inside the `load`
  handler.
- **Sources and layers must be added inside the load handler too.**
  `addSource()` / `addLayer()` before the style is ready throws *"Style
  is not done loading"* and the whole page dies.

**Settings persist across visits.** Overlay on/off + opacity and the
projection choice (globe / vertical-perspective / mercator) are saved
to `localStorage["xyzo.globe.settings"]` and restored on the next load
— same contract as the flat map's layer prefs, but under its own key
so the two views never clobber each other.

**Popups are dark-styled.** MapLibre's default popup is white with
dark text — unreadable against the dark theme. `globe.css` overrides
`.maplibregl-popup-content`, the tip (for all four anchor sides) and
the close button to match the flat map's dark popups.

**The flat-map globe button is a ringed planet** (Saturn-style), not a
second copy of the flat-map globe icon, so the two controls in the
zoom bar are instantly distinguishable. The zoom bar grew to four
buttons when the 3D link was added; `--zoom-stack` is now measured
from the real bar height (`syncZoomStack` in `app.js`) so the live
panel never covers the bottom button.

### The panel must be dismissible, and 44 px on a phone (2026-10-30)

On a phone `#globe-panel` is **298×606 on a 393×660 screen — 76 % of
the width, 92 % of the height** — and it shipped with **no close
affordance at all**, so the globe was a sliver down the right-hand
edge with nothing to be done about it. Full write-up in **"Mobile &
3D-globe review"**; the rules:

- **`#globe-panel-head`** is a `position: sticky` row inside the panel
  carrying the ✕ (`#globe-panel-close`). Sticky so the close button is
  reachable however far the overlay list is scrolled.
- **`#globe-panel-open`** ("☰ Layers") reopens it. **Without this the
  ✕ is a one-way door** — there is no other route back to the overlay
  list. `#globe-panel-open[hidden] { display: none }` keeps it out of
  the way while the panel is up.
- `wireGlobePanel()` persists `settings.panelOpen` alongside the rest of
  the view state. **A phone starts collapsed; a wide screen starts
  open.** A remembered choice always wins.
- Hiding the panel must **give the canvas its space back** on ≥1100 px
  (`#globe { left: 296px }` is what offsets it) — `body.globe-panel-
  hidden #globe { left: 0 }` plus `map.resize()`.
- **MapLibre's own controls ship at 29 px** — under the 44 px minimum
  touch target. `@media (pointer: coarse)` raises
  `.maplibregl-ctrl-group button`, the panel ✕ and the projection
  chips. The flat map's Leaflet controls already had this rule; these
  never did.
- The header bar has three items and 393 px to fit them in. It keeps to
  **one row** and truncates the story count, rather than wrapping into a
  tall band that eats the globe.

Pinned by `public_html/tests/globe.bun.test.js` and
`public_html/tests/mobile-close-affordances.bun.test.js`.


### The globe's gridded fields are baked in MERCATOR (2026-11-04)

The globe's three gridded fields — the **temperature**, the
**lightning density** and the **magnetic wash** — are painted as one
picture each and draped over the sphere as a MapLibre `image` source.

**An image source is a quad in MERCATOR space.** MapLibre turns its
four corners into mercator coordinates and stretches the texture across
that mercator rectangle, so the texture's V axis is *mercator*. The
globe used to bake the texture in **latitude** and drape it as if it
were mercator — so every latitude except the equator was sampled with
the wrong row. Measured on the 2026-11-03 cycle by projecting known
points and reading the painted pixel back:

| Point | Painted | The grid says | Error |
|---|---|---|---|
| 0°, 0° | 26 °C | 26.4 °C | right |
| 45°N, 0° | **38 °C** | 11 °C | **27 °C too warm** |
| −45°, 0° | 20 °C | 20 °C | right |

The poles came out hot, the Congo and Amazon lightning hotspots were
smeared across the wrong latitudes, and the whole thing read as "the
temperature map still doesn't look correct for 3D".

**The fix is a shared bake, not a patch.** `public_html/field-bake.js`
owns the canonical Web-Mercator bake and the ramp; the temperature,
the lightning and the magnetic wash all use it, and the flat map's
`temp-layer.js` reads the same ramp and the same `tileLat()`. **One
implementation, two views** — and the globe now shows the *same
picture* as the flat map, because the flat map's tile grid is Web
Mercator too.

The picture's quad stops at the **mercator limit** (±85.051129). At
±90° the projection is `y = Infinity` and the source silently never
renders — an invisible failure no screenshot catches.

### The globe's wind, currents, earthquakes, faults and language regions (2026-11-04)

The wind animation used to be listed as NOT portable: *"a screen-space
canvas animation tied to Leaflet's 2D projection; particles behind the
globe have no meaningful screen position."* That reason was **wrong**.

The globe's animation (`public_html/globe-wind.js`) keeps its particles
in **GEOGRAPHIC** space, projects them with `map.project()` each frame,
and **culls the far side of the sphere** with a back-face test — the
dot product of the point's direction vector with the camera's. A
particle behind the globe really has no screen position; the fix is not
to draw it, not to refuse to animate.

The same engine serves the **ocean currents** (their own published
u/v grid). The **earthquakes**, the **faults** and the **language
regions** are GeoJSON, so MapLibre reprojects them onto the sphere for
us. The globe now carries **21 overlays**; the flat map carries **33**
(the isobar lines plus 32 overlays), and the difference is an explicit
list with a reason for each entry (`panel-parity.bun.test.js`).

**The globe's streaks got the dark halo on 2026-11-07**, the same day
as the flat map's particles: `globe-wind.js` was stroking bare 1–2.6 px
lines, which lit **2.57 %** of its canvas over a satellite basemap. The
path is now built once and stroked twice (near-black ring, then the
core), and the same engine serves both the wind and the ocean currents,
so both got it: **2.57 % → 6.02 %**, still animating, `globe_wind_audit.py`
still green. The path reuse matters — this loop runs for every particle
every frame.

### A shared link must survive 2D → 3D → 2D (2026-11-07)

The handoff has one rule with two halves: **a round trip must not
amputate the reader's own map.** Measured with the new
`scripts/shared_link_parity.py` — open the flat link, follow the globe
button, open "Back to the map", diff both ends — the owner's own
15-overlay link lost **9 overlays and 3 settings** in a single round
trip. Four causes, all fixed:

- **The two vocabularies had five MORE mismatches than the bridge knew
  about.** `view-handoff.js`'s `ALIASES` held six entries; the flat
  map's `getLayerSlug()` actually emits **`wind-gfs`,
  `wind-speed-gfs`, `ocean-currents-live`, `earthquakes-usgs`,
  `tectonic-faults-usgs`** where the globe keys **`wind`,
  `wind-speed`, `ocean-current`, `earthquakes`, `faults`** — all five
  PORTED, so each one dropped a layer the globe could perfectly well
  draw (that link lost three at once). The check meant to catch it
  round-tripped the *globe's* key, a tautology whenever no alias
  exists; `panel-parity.bun.test.js` now runs the **shipped**
  `getLayerSlug()` over each globe label, and it is mutation-checked
  (delete one alias → two tests fail).
- **The globe cannot honour the flat map's settings, so it must carry
  them.** `applyGlobeHash()` rebuilds `location.hash` from the layers
  it drew and the back link is built from that, so `density=`, `wind=`,
  `rivers=`, `time=`, `base=`, `search=` and `pin=` were deleted by one
  visit. `flatOnlyParts(INCOMING_HASH)` appends every part the globe's
  own writer does not produce — `overlay=`, `proj=`, `iso=`, `isoSrc=`
  and the position are the globe's, everything else rides through.
- **Overlays the globe cannot draw ride home in the BACK LINK only.**
  `globe.js` calls `XYZO_HANDOFF.registerGlobeKeys(OVERLAYS.map(…))`,
  and `flatHref(globeHash, incomingHash)` puts back the incoming
  entries that are not among them — entries that *cannot* have been
  switched off there, because there is no checkbox for them. The
  globe's own URL still lists only what it draws, and a layer the
  reader did switch off on the globe is not resurrected.
- **`iso=` and `isoSrc=` were already read by the globe** and are
  unchanged: `iso=0.1:pressure` + `isoSrc=gfs` round-trip exactly.

Two audits pin it: `scripts/globe_handoff_check.py` (**6/6**, was 2/6)
and `scripts/shared_link_parity.py` (**0 lost**, both directions).

## Caddy: missing tiles answer transparent, not 404 (2026-10-28)

The builders skip empty tiles (ocean / no-data), but Leaflet requests
the full viewport grid regardless. Every skipped cell used to land in
the browser console as a red 404 — and worse, the `*.png immutable`
header rule applied to those 404s, so browsers **cached them for a
year**. A tile that later got built was invisible behind the cached
404.

Caddy now answers any missing file under `/data/soil/*`,
`/data/cropland/*` or `/data/koppen/*` with a 334-byte transparent PNG
(`public_html/data/empty-tile.png`):

```caddy
@missingTile {
    path /data/soil/* /data/cropland/* /data/koppen/*
    not file
}
handle @missingTile {
    rewrite * /data/empty-tile.png
    file_server
}
```

Real tiles fall through to the catch-all `file_server`. Note that
Caddy's path `*` is a prefix wildcard that **crosses slashes**
(`/data/soil/*` matches `/data/soil/wrb/tiles/4/6/5.png`); `**` is not
a path-matcher wildcard at all.

If you ever need to bust clients that cached a pre-fallback 404, bump
the layer's `BUILD` constant — a new `?v=` is a cache miss.

**The NASA GIBS tiles could not use that route** — they are on another
server, so Caddy cannot answer for them. They go through
`api/src/routes/tileProxy.ts` instead, which applies the same rule in
the API: **a missing tile answers HTTP 200 with a 1×1 transparent
PNG**. See *The NASA tile proxy* below.

## Opacity Sliders — every overlay (2026-10-28, audited 2026-10-29)

Every entry in the Leaflet layers dropdown gets a slider (values stored
in `localStorage["xyzo.overlayOpacity"]` and carried in the shared link
as `overlay=name@pct`).

**Audited 2026-10-29 in a fresh browser (empty localStorage): 24/24
overlays match their declared default, readouts match sliders, no
zeros/NaNs, and `setOpacity`/`getOpacity` round-trip on the tile- and
GeoJSON-backed modules.** The declared defaults are:

| Group | Default | Semantics |
|---|---|---|
| NASA satellite / rain / night, Facebook | 85 / 65 / 80 / 60 | absolute CSS |
| Köppen, Temperature, Wind | 50 / 90 / 95 | absolute CSS |
| Soil, Cropland, Land Cover | 55 / 55 / 50 | absolute CSS |
| Geology, Geologic contacts | 70 / 85 | absolute CSS |
| Relief (ETOPO) | 85 | absolute CSS |
| Wave height & power | 90 | pane `opacity` + repaint |
| City names, Languages | 100 | canvas `style.opacity` |
| Lightning, Phytoplankton, Transport, Salinity, Ocean | 90 / 90 / 85 / 85 / 85 | as implemented by each module |
| Rivers, Magnetic, Hydrological Basins | **100** | **multiplier** — see below |

**Two semantics, both deliberate:**

- **Tile layers** (NASA, Köppen, temp, soil, cropland, geology, relief)
  treat the slider as an **absolute CSS opacity**: 55% means the tile
  container really is `opacity: 0.55`.
- **Vector / GeoJSON washes** (rivers, magnetic, hydrological basins)
  treat it as a **multiplier on a coded base style**: the slider at
  100% paints at the module's authored look (e.g. rivers stroke 0.9,
  basins stroke 0.85 / fill 0.16), and sliding down dims from there.
  That is why those three sit at 100 — their visual weight lives in
  the style, not the slider. Both semantics round-trip correctly
  through `setOpacity` → `getOpacity`.

The contract: every module in `WEATHER_OVERLAYS` **must provide
`setOpacity`** on the object it returns from `getTileLayer()`. The
opacity module guards each call, but a layer that silently ignores the
slider is still a bug — pinned by `overlay-contracts.bun.test.js`.

**The URL must report the LIVE opacity — and for seven overlays it was
reporting the reader's preference instead (2026-11-07).** `getMapHash()`
reads `overlayOpacityFor()` → `OverlayOpacity.get()`, whose **only
caller is that hash writer**. `get()` read `loadStored()` first, so for
any overlay whose registered layer has no numeric `options.opacity` —
the module-backed vector layers: **basins, rivers, magnetic, ocean
currents, language regions, earthquakes, faults** — the URL carried the
reader's own stored preference while the map was showing the link's
value. Measured with the new `scripts/overlay_opacity_probe.py` (20
overlays at **37 %**): the map drew 37 % and the URL said **100 %** for
all seven — so re-sharing your own link silently reset the opacity, in
both views, because the globe reads the same `slug@pct`. `get()` now
resolves **`VIEW_OVERRIDES` → stored → default**, the same order
`mount()` already used (they had drifted, and the URL and the slider
were being decided by two different rules). A link's opacity still never
touches the store, and moving a slider still clears the override.
**After: 0 of 20 wrong**, pinned by a behavioural test rather than a
source match.

## Layers Panel UX — both viewports start closed, ✕ close, master Markers toggle (2026-10-29, 2026-11-06)

The layers dropdown is the single place for layers, so its two UX
defects were felt on every visit:

**BOTH VIEWPORTS START CLOSED** (owner, 2026-11-06: *"don't start with
the two control windows open when someone first visits"*). A first
visit shows the **map**. The constructor is still
**`collapsed: isPhoneViewport()`**, because that option decides the
panel's *semantics*, not its start state:

- **`collapsed: false` (desktop) makes the panel sticky once opened.**
  Leaflet only binds map-click → collapse and mouseleave → collapse
  when `collapsed: true`, which is the *"suddenly disappears while you
  are reaching for a slider"* bug — reaching for a slider is a click
  **outside** the panel's own box as far as the map is concerned.
- **`collapsed: true` (phone) gives Leaflet its tap-to-open wiring**
  (`mouseenter → _expandSafely`) that `makeLayersToggleTouchFriendly`
  builds on — and on a 393×660 screen the panel is 576 px of
  scrollable list that would otherwise cover the whole map from the
  first tap.

So desktop is **constructed open** (its `_initLayout` calls
`expand()`) and **closed again one line later** with
`layersControl.collapse()`, in the same synchronous block as the
constructor — nothing can paint it open. This works because the
toggle's `click` handler sits **outside** the `collapsed && …` guard
in Leaflet's `_initLayout`, so a `collapsed: false` control still
re-expands on a click (the path that already shipped: open → ✕ →
click the toggle to reopen). The Live Feed panel is the same rule:
its markup ships `class="live-panel collapsed"` (closed even before
`app.js` runs — verified with `app.js` blocked) and
`setPanelCollapsed(true)` runs unconditionally rather than only under
768 px. **The state is not persisted** — every load starts clean.

**No close affordance.** With `collapsed: false` it would stay open
forever, so `mountLayersCloseButton()` appends a **✕**
(`.leaflet-layers-close`) to the panel's top-right corner, wired to
`layersControl.collapse()`. It re-attaches **idempotently** on
`overlayadd` / `overlayremove` / `baselayerchange` — and, since the
panel now starts collapsed on **every** viewport, the class
MutationObserver is what creates it on the first expand (it early-returns
while collapsed). Leaflet rebuilds the panel's DOM on every layer
change.

> 🔴 **THE ✕ MUST BE HIDDEN WHILE THE PANEL IS COLLAPSED.**
> `mountLayersCloseButton()` appends the ✕ to the control and **never
> removes it**, so it survives `collapse()` still sitting in the panel's
> top-right corner. While collapsed the panel is only the stack-icon
> toggle — the same box, and on a coarse pointer both are 44×44 — so the
> ✕ lands **directly on top of the toggle** and swallows every tap. Its
> own handler then calls `collapse()` again, so tapping the layers icon
> did **nothing**: after the first ✕ the layers panel could never be
> reopened. This hit **desktop as well as mobile** (the symptom was
> "the X button breaks the layers"). The CSS rule
> `.leaflet-control-layers:not(.leaflet-control-layers-expanded)
> .leaflet-layers-close { display: none }` takes it out of hit-testing.

**Master 📍 Markers toggle.** `mountMarkersRow()` injects a checkbox
row into the dropdown, as a **sibling** of
`.leaflet-control-layers-overlays` (Leaflet empties that list on every
layer change — same contract as the Story-links and isobar rows):

- **Off** → `setMarkersVisible(false)` deletes `markers`, `clusters`
  and `heatmap` from `activeModes` in one shot: the canvas clears
  (`display: none`) and `applyLayers()` runs. The mode-dropdown
  buttons and its label sync to **Off**.
- **On** → restores the default single-marker mode only
  (`activeModes.add("markers")` if the set is empty) — clusters and
  heatmap stay the user's explicit choice from the mode dropdown.
- The checkbox re-syncs from live state via
  `window.__syncMarkersToggle` whenever the mode dropdown changes the
  set.

**The initial checked state must NOT touch `activeModes`.** That
`const` is declared ~750 lines below `mountMarkersRow`, so reading it
at parse time is a temporal-dead-zone error that aborts the rest of
`app.js` (caught by the screenshot harness). The checkbox defaults to
the `markersVisible` flag and the first `applyLayers()` corrects it.

**Per-pin ✕ (DOM path only).** Every DOM pin (`buildMarkerDiv`)
carries a hover ✕; `wirePinDismiss()` handles it with a
**capture-phase** delegated listener on the map container (pins are
re-created constantly — per-marker binding would leak). The handler
stops propagation so the popup never opens, then drops the marker from
`map`, `pinMarkers`, `eventMarkers` and both cluster groups. It is
temporary: the next viewport fetch re-creates it (hiding a story
permanently would need server state).

> ⚠️ **The canvas renderer — the fast path at normal zoom — draws pins
> with no DOM nodes, so there is no per-pin ✕ there.** The master
> Markers toggle is the reliable off-switch for both paths; the
> per-pin ✕ only exists where DOM pins do (very high zoom / canvas
> disabled).

**Verified end-to-end** (Playwright): toggle off → canvas
`display: none`, `activeModes = []`; toggle on → canvas restored,
`activeModes = ["markers"]`; zero page errors throughout.

Pinned by `public_html/tests/markers-off.bun.test.js` (13 tests: the
row is a sibling of the overlay list and is re-mounted after rebuild,
the toggle clears all three modes, mode buttons + label stay in sync
including the Off state, `collapsed: false`, the ✕ calls
`layersControl.collapse()`, the close button re-attaches
idempotently, the pin ✕ is capture-phase with
`stopImmediatePropagation`, dismissing removes the marker from the
map + registries + cluster groups).

## Mobile & 3D-globe review — the five ✕ that failed (2026-10-30)

**Everything below was found by driving a real phone profile** —
Playwright Chromium with the **iPhone 14 Pro** descriptor (393×660,
`hasTouch`, `isMobile`) — using **real `touchscreen.tap()` events**, not
by reading the code. Every one of these five defects was invisible on a
1440×900 desktop viewport, and four of the five were invisible to
`document.elementFromPoint()` too: the DOM said the control was on top
while the finger landed somewhere else.

The harness is in the session notes; the invariants are pinned by
**`public_html/tests/mobile-close-affordances.bun.test.js`** (27 tests
across 8 describe blocks — layers ✕, layers scrolling, the Help Me
overlap, popup ✕, the globe panel, the outage banner, and the debug
overlay gate).

### 1. The layers ✕ blocked the layers toggle (desktop + mobile)

`mountLayersCloseButton()` appends the ✕ to the panel and never removes
it, so it outlived `collapse()` sitting in the panel's top-right corner.
Collapsed, the panel is only the stack-icon toggle — **the same 44×44
box** — so the ✕ sat on top of it and swallowed every tap, then called
`collapse()` again. Measured: `elementFromPoint` at the toggle's centre
returned `BUTTON.leaflet-layers-close`.

**After the very first ✕ the layers panel could never be reopened.**
Fixed in CSS, not JS — `display: none` is what removes an element from
hit-testing:

```css
.leaflet-control-layers:not(.leaflet-control-layers-expanded) .leaflet-layers-close { display: none; }
```

### 2. The mobile layers panel was not scrollable — 26 overlays unreachable

`makeLayersToggleTouchFriendly()` **hand-rolled** the open (add the
class, `display: block`) and never called `layersControl.expand()` —
which is the only thing that caps the list and adds
`leaflet-control-layers-scrollbar` (`overflow-y: scroll`). Measured on a
phone: panel **3,078 px** on a 660 px viewport, `overflow-y: visible`,
`scrollTop` stuck at 0. Rows from **Phytoplankton** down — Soil,
Cropland, Land Cover, Rivers, Magnetic, Transportation, Salinity, Ocean
Currents, Basins, Geology, contacts, Relief, Waves, City names, Markers,
Story links — plus the whole Köppen key were **below the fold with no
way to scroll to them**.

The touch toggle now routes through `setLayersPanelOpen()`, which calls
`expand()` and then `capLayersListHeight()` — that re-caps with a
**measured** bottom reservation (Leaflet hard-codes 50 px; a phone's
`#bottom-bar` floats over the map and needs more). The cap re-applies on
resize/orientation, and the list gets `-webkit-overflow-scrolling: touch`
so iOS rubber-bands properly. Now **560 px cap over 3,101 px of list**,
scrollable, and all **39 rows reachable**.

### 3. "🆘 Help Me" covered the ⚙ tools button and the Markers button

`#help-me-btn` is `position: fixed; right: 12px; bottom: 12px;
z-index: 9998`; `#bottom-bar` is `position: fixed; z-index: 500`. On a
phone the bar spans the full width, so the pill landed on the bar's
**right end — exactly where ⚙ and Markers live**. Measured overlap
**4,580 px²**, and `elementFromPoint` at the gear returned
`#help-me-btn`. The **entire control menu was untappable on mobile** —
text size, saved styles, export, digest, legend, wiki, density, pin
mode. Desktop's bar is only 454 px wide and never reaches the right
edge, which is why it never showed there.

`publishChromeEdges()` measures the real bar and writes
**`--help-me-bottom`**; the pill rides **above** the bar only when the
bar actually reaches under it. Measured, not hand-tuned — the bar's
height depends on the safe-area inset and the button font size.

### 4. The popup's ✕ Close fell off the right-hand edge

**CSS `zoom` is invisible to Leaflet.** The text-size control gives
`.leaflet-popup-content-wrapper` `zoom: var(--ui-zoom)` — **1.15 by
default (A+)**. Leaflet measures `offsetWidth` *before* the zoom, takes
`maxWidth` from it, and auto-pans to fit **that number** — while the
popup renders 15 % wider. Measured on a 393 px phone: content asked for
**341 px**, rendered **392 px**, wrapper **424 px** — and the ✕ Close,
absolutely anchored to the **rendered** right edge, landed **outside the
screen**. It worked at the A setting and failed at the default.

Two fixes, both needed:

- **`popupMaxWidthForViewport()`** hands Leaflet the **pre-zoom** width
  (`min(340, innerWidth − 96) / zoom`), so its own layout and pan maths
  are right. The CSS `max-width` divides by the zoom too — `max-width`
  resolves *inside* the zoomed space, so the old `calc(100vw - 24px)`
  was rendering 15 % over the viewport.
- **`keepPopupOnScreen()`** replaces Leaflet's autoPan, which is
  **animated** — a correction run after `popupopen` *races* with it and
  the popup lands wherever the last pan finished (**2 of 6** popups still
  off-screen). `autoPan: false`, and one measured, immediate pan that
  also clears the **search pill** and **`#bottom-bar`** (a ✕ behind
  either is as un-closable as one off the edge). It corrects only an
  axis the popup actually fits on, and pans the **map** — the popup stays
  anchored to its pin.

`openPinPopup()` also **waits for `moveend` on a touch device** instead
of opening 150 ms into a 400 ms pan. A popup that appears mid-pan slides
for the rest of the animation, so a tap aimed at the ✕ lands on whatever
moved into that spot — the **intermittent** version of the same bug.

### 5. The 3D globe had no way to dismiss its panel

On a phone `#globe-panel` is **298×606 on a 393×660 screen — 76 % of
the width, 92 % of the height** — with **no close button at all**. The
globe, the whole point of the page, was a sliver down the right-hand
edge.

- **`#globe-panel-head`** carries a ✕; **`#globe-panel-open`** ("☰
  Layers") brings it back, so the ✕ is never a one-way door.
- The choice persists in `settings.panelOpen` (same contract as the rest
  of the view state). **A phone starts collapsed**, a wide screen starts
  open.
- On ≥1100 px the canvas is offset to clear the panel, so hiding it
  gives that space back (`body.globe-panel-hidden #globe { left: 0 }` +
  `map.resize()`).
- MapLibre's own controls ship at **29 px** — under the 44 px minimum
  touch target. Raised to 44 px under `@media (pointer: coarse)`, the
  same rule the flat map's Leaflet controls already had.
- The header bar (back link + title + story count) now truncates on one
  row instead of wrapping into a tall band that ate the globe.

### Also fixed: the 🐛 debug button shipped to everyone

`map-debug.js` built its floating UI unconditionally, so every visitor —
including phone users — got a **"🐛 debug"** button at
`bottom: 12px / left: 12px`, on top of the language selector in
`#bottom-bar`. It is now gated behind the house opt-in (`?debug` in the
URL, which remembers itself, or `localStorage["xyzo.debug"] = "1"`), and
it finally carries a `?v=` token in `index.html` (it had none, so a
cached copy could never pick up a fix). Verified both ways: absent by
default, present with `?debug`.

### And: the outage banner covered the popup's ✕

Found by accident — the pins API failed transiently mid-review, the site
showed its `#system-wide-error-banner`, and the popup that was already
open **could not be closed**: the banner is `z-index: 9999` against the
popup pane's `1200`, and it was anchored to `--top-band` alone. That
variable measures the **control stack** only, so the banner slid under
the search pill and straight over the top of any top-anchored popup —
`elementFromPoint` at the ✕ returned `DIV.system-wide-error-banner`.

It now reserves the **measured** chrome (`--map-top-chrome`, published
from `#search-bar`'s real height by `trackControlBand()`), is capped to
the space that is actually free (`max-height` + `overflow-y: auto`, so
its three buttons cannot run into the bottom bar on a 390 px screen), and
stays dismissible. Verified with the API deliberately aborted: banner
clears the search pill *and* the bottom bar.

**The general rule:** an overlay that is `position: fixed` with a
z-index above the popup pane can silently make a popup un-closable. Any
new floating banner has to reserve the chrome, not just the viewport.

### The rules this review produced

- **Every ✕ must be `display: none` when what it closes is closed.** A
  close button is absolutely positioned; its parent collapsing does not
  move it out of hit-testing.
- **Never hand-roll a Leaflet control's open/close.** Call the control's
  own API — it caps, scrolls and keeps its internal state in sync.
  `setLayersPanelOpen()` exists for exactly this.
- **Anything floating over the bottom bar must be measured against it.**
  `publishChromeEdges()` writes `--help-me-bottom`.
- **CSS `zoom` breaks every measurement Leaflet makes.** Divide widths
  by `popupUiZoom()` before handing them to Leaflet, and divide CSS
  `max-width`/`min-width` by it too.
- **A popup must be still when the user taps it**, and its ✕ must be
  inside the viewport *and* clear of the search pill and the bottom bar.
- **Review on a real phone profile with real touch events.** Four of
  these five defects lied to `elementFromPoint` and every one of them
  passed a desktop-width screenshot.

Pinned by `public_html/tests/mobile-close-affordances.bun.test.js` and
`public_html/tests/markers-off.bun.test.js`.

## The popup after a search, on a phone (2026-11-11)

**THE GATE IS A MOBILE AUDIT, AND THIS SITE HAD NONE.** Every Playwright
script in `scripts/` drives a **desktop** viewport (1280–1440 px) — the
phone is where the map is actually used, and the phone is where the
popups broke. `scripts/search_mobile_audit.py` is the first one that
drives a real phone profile:

```bash
python3 scripts/search_mobile_audit.py --query chicago
# == phone 393x852 · search 'chicago' ==
#   status line: All news in Chicago, Illinois, US · 9 stories
#   PASS  a popup exists after the tap
#   PASS  the popup is fully inside the viewport — box=10,215 → 379,595
#   PASS  the ✕ Close button is inside the viewport — close=286,225 → 369,257
#   PASS  the popup is still 1500 ms after the tap — max movement 0.0 px
#   PASS  the mobile Details button has its content block
#   PASS  tapping the ✕ closes the popup
#   PASS  no page errors / PASS  no console errors
```

`b.new_context(viewport={"width":393,"height":852}, is_mobile=True,
has_touch=True, device_scale_factor=3)` and **real touch** —
`page.touchscreen.tap(x, y)`, never `page.click`. It finds a tappable
pin the way `scripts/hover_audit.py` does — `window.__xyzoExportPins()`
for the coordinates and `document.elementFromPoint()` to prove the point
is **reachable** (a pin under the layers dropdown or the bottom bar is
not a pin a finger can hit) — then it measures the popup's box, the ✕'s
box, whether the popup is **still** 1.5 s after the tap, and whether
tapping the ✕ closes it. It exits non-zero when a check fails.

### The five defects, and what each one measured

| # | The defect | The measurement |
|---|---|---|
| 1 | **The framing panned the wrong way.** `map.panBy([dx, dy])` moves the map's **CENTRE** by (dx, dy), so the popup — anchored to its pin — moves the **OTHER** way. The correction had the **same** sign as the screen-space error. | The popup walked from **34 px past the right edge to 970 px above the top of the screen in FOUR corrections, each DOUBLE the last** — each was computed from the position the previous wrong-way one had produced. |
| 2 | **The popup opened into a flight.** Leaflet's own `click → _openPopup` handler opened it **synchronously** — 0 ms into the **700 ms** `flyToBounds` that `maybeZoomToCluster()` starts for any pin with ≥3 neighbours within 30 km (after a search: nearly every pin). | The popup opened at t=0 and the flight ran to t≈700 ms, so it **rode** the flight. |
| 3 | **The framing never re-ran.** `keepPopupOnScreen()` ran at `popupopen` and one tick later — **during** the flight. | Nothing re-framed the popup once the flight landed. |
| 4 | **The status line was not reserved.** `#search-status` is `position: fixed; bottom: 58px` and only exists **after a search**; the framing measured the bottom bar's **HEIGHT**, ~14 px short of its top edge. | The popup could land on the line that says "All news in Chicago · 9 stories". The measured edge is published as **`--bottom-bar-top`**. |
| 5 | **The mobile "Details ▸" button was dead.** The mobile branch emitted `.popup-details-full`; the wiring looked for `.popup-details-content`. | On a phone the keywords, the related stories, the locations and the reports were **unreachable**. One class name now, in both places. |

Two more, found by the same audit:

- **`maybeZoomToCluster()` counted every pin TWICE** — the canvas list and
  the DOM marker registry hold the *same* search results, so the "≥3
  neighbours" test fired on a single pin and started a 700 ms flight for
  nothing. It is deduplicated by pin id now.
- **`restoreActivePopup()`'s standalone popup was never wired**, so its
  action buttons (read more, fix, report, love, star, recommend) were
  dead. The popup state now carries the **pin data**, and the standalone
  popup is wired like any other.

**AND THE FIRST-VISIT TOUR WAS THE THING THAT FINISHED THE JOB.** The
tour card is the only thing the tour puts on the **pointer path** — at
z-index 9998, above the popup pane (1200), and a **bottom sheet** on a
phone. Measured, the element at the ✕'s own coordinates was
`xyzo-tour-title`: the tap landed on the tour, not on the button, and the
popup could not be closed. **A search now ends the tour**
(`endTourForSearch()` → `XYZO_TOUR.stop()` **and** `markSeen()`, because
`stop()` only marks it seen when the tour was *open* — otherwise the
auto-start would fire later, over the popup).

### The rules this produced

- **A POPUP MUST NOT OPEN WHILE THE MAP IS MOVING**, and the wait lives
  in **ONE** helper: `openPopupWhenSettled()`. The DOM-marker path, the
  canvas-pin path and the event-marker path all call it.
- **THE FALLBACK IS A BOUND, NOT A DEADLINE.** A 700 ms flight is
  **longer** than the 600 ms coarse-pointer wait, so a fallback that
  simply fired opened the popup 600 ms **into** the flight — the very
  bug. It **re-arms** while the map is moving (up to 3 s).
- **LEAFLET'S OWN `click → _openPopup` IS REMOVED** from the pin and
  event markers (`marker.off("click", marker._openPopup)`). It is
  registered by `bindPopup()` and runs **before** any handler that could
  defer the open.
- **THE FRAMING PANS THE MAP, AND THE SIGN IS THE MAP'S.** The popup
  moves the other way. Get this backwards and every correction pushes the
  popup further away.
- **ROUND THE CORRECTION BEFORE THE ZERO TEST.** Leaflet rounds the
  offset itself, and its `panBy([0, 0])` fires `moveend` **without
  moving** — so a fractional correction fed the framing pass straight
  back into itself and the reader got *"Maximum call stack size
  exceeded"* instead of a popup.
- **A USER DRAG MUST NEVER BE FOUGHT.** The framing re-runs on
  `moveend`/`zoomend`, but only for a **programmatic** move: the popup is
  anchored to its pin, so the reader is allowed to walk away from it (on
  a phone the popup is closed outright).
- **THE CANVAS SHIFT HACK READS THE POPUP'S OWN ELEMENT.**
  `document.querySelector('.leaflet-popup')` returns the **first** popup
  in the *document*, which may be a fading one — the canvas path rewrote
  a stranger's transform while the map flew. It stops when the map
  settles: a popup that is not riding a flight does not move.

Pinned by `public_html/tests/search-mobile-popup.bun.test.js` (16) and
measured by `scripts/search_mobile_audit.py`.

## Legibility sweep — the surfaces the text-size control forgot (2026-10-30)

**The selectable font size already existed.** ⚙ → MAP → Text size, A /
A+ / A++, defaulting to **A+ (115 %)**, applied before first paint.

The problem was that it covered **nine selectors**:

```css
.live-panel-header, .live-panel-list, .live-panel-status,
.leaflet-popup-content-wrapper,
.explore-panel > *, #help-panel > *,
.overlay-card > *, .bar-dropdown > *, .nav-links
```

Everything the map is actually **operated through** was missing from
that list — the layers dropdown, its legends, the bottom bar, the
control menu, the probe cards and the hover HUD. Measured on a phone,
the setting changed nothing on any of them:

| Surface | Specified | Actually rendered | Scaled? |
|---|---|---|---|
| layers dropdown — a layer row | 13 px | **13 px** | no |
| bottom bar — a button | 12 px | **12 px** | no |
| temperature legend — title | 11 px | **11 px** | no |
| climate key — a chip | 11 px | **11 px** | no |
| live panel — header | 16 px | 18.4 px | yes |

`styles.css` carried **148 uses of 11 px, 112 of 10 px, 75 of 12 px**.
The site is built on 10–12 px text and most of it ignored the setting.

### The trap: do NOT put Leaflet-measured surfaces on the zoom list

The obvious fix — add the layers dropdown to the `--ui-zoom` list — is
exactly what caused the popup ✕ bug fixed earlier today. **CSS `zoom` is
invisible to Leaflet**: it measures the element *before* the zoom, so a
zoomed layers panel renders taller than the height cap believes and the
3,078 px unscrollable panel comes straight back.

So the layers dropdown and its legends **cannot** go on the zoom list.
The safe lever is raising the **base** sizes: no measurement semantics
are involved and Leaflet's maths is untouched. The zoom control keeps
compounding on top of them.

### What was raised

A scoped sweep — only rules whose selectors **all** fall inside one
target scope, only the 9/10/11/12 px tiers, **80 rules**:

| Tier | → | Where |
|---|---|---|
| 9 px | 11 px | legend ticks (10), probes (4) |
| 10 px | 12 px | legends (16), probes (11), control menu (1) |
| 11 px | 13 px | legends (21), probes (9), control menu (3) |
| 12 px | 14 px | bottom bar (2), legends (1), probes (1), control menu (1) |

Plus **`globe.css`** (14 rules), which has no Leaflet involvement at all.

**The two `em` rules in Leaflet's vendor CSS were the real find.**
`.leaflet-control-layers label` (every layer row) and
`.leaflet-popup-content` are both sized `1.0833em`, against an inherited
base **this codebase never set**. So the row resolved to
**12.75 px** — smaller than the legend captions around it — and no
amount of editing our own rules moved it. It is now an explicit **14 px**
override. The popup body was deliberately **left alone**: its wrapper
carries `zoom: var(--ui-zoom)` and `popupMaxWidthForViewport()` derives
the popup's width from that zoom, so raising it here would fight the
arithmetic that keeps the ✕ Close on-screen.

### Four defects the sweep exposed, and the fix for each

**1. The control menu's chips wrapped to two lines.** Three chips
("Last used", "My default", "✨ Cool") share one row in a ~300 px menu.
Reverted to the shipped **11 px** with `white-space: nowrap` and
`overflow-x: auto` — the legibility win comes from the taller 32 px box,
not the glyphs. Same for `.ctrl-toggle`'s neighbours.

**2. "Markers" in the bottom bar was clipped.** `#markers-dropdown-btn`
measured **76 px of content in a 46 px box** — the label was cut off
mid-word. The hide-labels rule matched `span[data-i18n]`, and
`#markers-dropdown-label` is a **plain `<span>` with no `data-i18n`**, so
it escaped and survived into a box too narrow for it. The rule now
matches the icon-label wrapper directly, with a `:not()` keeping
`#time-dropdown-label` — "24h" fits in 44 px and is the one piece of
visible **state** on the bar.

**3. Legend tick labels overhung the unit column.** The ticks are
positioned by `s.style.left = <pct>` with **no centring**, so a tick at
100 % *starts* at the bar's right edge and its glyphs run into the 26 px
gutter holding "°C"/"°F". Invisible at 9 px; a collision at 11 px.
The first attempt — `transform: translateX(-50%)` on every label —
fixed the right end and **broke the left**:
`.leaflet-control-layers-scrollbar` has `overflow-x: hidden`, so the
leftmost label lost its minus sign ("-40" rendered as "40"). The correct
fix adjusts **only the end labels** (`:first-child` stays, `:last-child`
gets `translateX(-100%)`), applied to the temp, lightning and
phytoplankton legends. Verified: 0 clipped labels across 5 legend rows.

**4. The Help Me pill covered the layers panel.** The earlier fix lifted
it above the **bottom bar**; nothing cleared the **layers panel**, which
owns the same screen column. `mountLayersCloseButton()`'s existing
`MutationObserver` now also publishes
`--layers-panel-h` and sets `data-layers-open="1"` **only when the
panel's box actually reaches the pill's corner** (measured, not
hand-tuned). On a phone the panel is capped to the viewport and covers
it, so the pill slides clear; on a desktop the panel stops short, the
flag stays unset and nothing changes. Verified on both, panel open and
closed.

### The rules this sweep produced

- **The A / A+ / A++ control scales nine selectors.** A surface that is
  not one of them is NOT scaled. Add it there only if nothing measures
  it — and nothing in Leaflet may be added, for the reason above.
- **Raise base sizes to move Leaflet-coupled UI; never `zoom` it.**
- **An `em` in vendored CSS resolves against a base you may not have
  set.** Measure the rendered px, do not read the stylesheet.
- **A percentage-positioned label overhangs at both ends.** Adjust the
  ends, never every label — `overflow-x: hidden` will clip the fix.
- **A hidden-labels rule must match the element, not an attribute you
  assume.** `span[data-i18n]` missed the one span that mattered.
- **Verify with a real phone profile and a clipping check**, not a
  screenshot: every one of these four passed a desktop-width screenshot.

Sweep scripted (`/tmp/opencode/bump_fonts.py` in the session) and
**comment-safe** — the first version stripped comments before writing,
deleting all 246 explanatory comments from `styles.css`. In this
codebase those comments are the record of *why*, so the script now masks
them for matching only and applies edits by offset.

Tests: **907 pass / 0 fail**.

## Control menu — the clear band between the chrome (2026-10-30)

The ⚙ **control menu** (`#control-menu`) is a fixed dropdown that lives
in the band between the search pill at the top and the bottom bar at the
bottom. Every anchor it used was a **typed constant that had drifted from
the real chrome**, and the menu collided with three different pieces of
furniture depending on which anchor you fixed.

Measured on an **iPhone 14 Pro (393×660)**:

| Quantity | Typed value | Real value | Consequence |
|---|---|---|---|
| `bottom:` | `58px` | **70 px** (the bar's top edge) | menu sat 12 px *inside* the bar |
| `top:` | *(none)* | **52 px** (`#top-bar`'s bottom) | menu grew up under the search pill |
| clear band | — | **538 px** | menu's natural height is **799 px** |
| menu width | shrink-to-fit **323 px** | row needs **333 px** | "✨ Cool" chip clipped |

### 1. `bottom: 58px` was the bar's HEIGHT, not its top edge

`#bottom-bar` is `bottom: 12px` and ~58 px tall, so its **top edge is
70 px** above the viewport bottom — and on a device with a home
indicator it is further still, because the bar grows by
`env(safe-area-inset-bottom)`. A `bottom:` anchor needs the *edge*, so
the menu's last row, **"AI / Help", was 12 px behind the bar**.

`publishChromeEdges()` — renamed from `publishBottomBarHeight()`, which
only ever measured the bar — now writes both distances:

```js
--bottom-bar-top:    window.innerHeight - bar.getBoundingClientRect().top
--top-chrome-bottom: topBar.getBoundingClientRect().bottom
```

Re-measured on resize, orientation change and after the i18n labels
land, because both bands move.

### 2. There was no top constraint at all

The menu is **799 px tall in a 538 px band**, so it can never fit — it
has to **scroll inside a box bounded by both edges**. Anchoring only to
the bottom grew it up over the search pill; anchoring only to the top
let it slide under the Help Me pill.

**`--top-band` is not the answer.** It measures the *map control stack*,
which sits below the search pill, so a menu clamped to it slid under the
pill anyway. `#top-bar`'s own bottom edge is the quantity an overlay
anchored at the top has to clear, and nothing published it.

```css
.bar-dropdown {
  bottom: calc(var(--bottom-bar-top, 58px) + 12px);
  top:    var(--top-chrome-bottom, 52px);
  max-height: calc(100vh - var(--top-chrome-bottom, 52px)
                         - var(--bottom-bar-top, 58px) - 12px);
}
```

The 52 px / 58 px fallbacks are the measured values on a 393×660 phone,
so the layout is correct before JS runs.

### 3. The scroll needs `min-height: 0` AND `flex: 1 1 auto`

Both are load-bearing, and without them the 550 px shell **clips
silently**:

- The shell is a **column flex container**, so `.control-menu-inner` is a
  flex item whose *automatic minimum is its content height*. It
  **stretches** to 918 px, overflows the 550 px shell, and
  `overflow-y: auto` never engages — `scrollHeight === clientHeight === 918`,
  so nothing scrolls and there is no scrollbar to notice.
- `flex: 1 1 auto` makes the basis resolve against the shell's **definite**
  box instead, so the inner becomes 456 px against 799 px of content and
  the scroll engages.

Verified: `scrollTop` reaches 343, "AI / Help" lands at y=566 with a
**24 px gap** above the bar.

### 4. `#help-me-btn` painted OVER the menu

The pill is `z-index: 9998`; the dropdown is `z-index: 10000` — but the
pill is `position: fixed` on `<body>` while the dropdown's stacking
context resolves differently, and the pill sat on top of **~5 rows
("MY STYLE", "Save this view", "Next visit", "My default map") — about
45,000 px²**. On a 393 px phone the menu is centred and spans the whole
band, so **there is nowhere the pill could move to**; hiding it is the
only option, and it costs nothing because it is an emergency
affordance, not a control.

```js
function setDropdownOpen(open) {
  if (open) document.body.setAttribute("data-dropdown-open", "");
  else      document.body.removeAttribute("data-dropdown-open");
}
```

The flag is set in `closeOtherMenus()` — which runs **before** the caller
shows its menu, so the answer is simply `!!exceptMenuId`, and a second
loop could only ever see the menus that were just closed. It is cleared
by **one document click listener**, not six close paths: each dropdown
hides its own menu in its toggle's else-branch, an outside-click handler
and an option click, and six sites is six chances to drift.

### 5. The menu was 19 px too narrow (found on the way)

Shrink-to-fit settled at **323 px** while the widest row — four 44 px
chips, the WCAG 2.5.5 touch floor — needs **305 px of content plus 28 px
of padding = 333 px**. The **"✨ Cool" chip lost its tail at every text
size**, so it was not a sweep artefact. `width: max-content` re-centres
at 352 px with 20 px of viewport margin either side; because the shell is
centred with `translateX(-50%)`, growing it cannot push it off-screen.

### The rules this pass produced

- **A `bottom:` anchor needs the element's TOP EDGE, not its height.**
  The element is itself offset from the viewport bottom, and that offset
  grows by the safe-area inset.
- **`--top-band` measures the map control stack**, not `#top-bar`. An
  overlay anchored to the top needs the latter.
- **A fixed dropdown that cannot fit must scroll inside a box bounded by
  BOTH chrome edges** — clamping to one side just moves the collision.
- **A column flex container's child will not shrink below its content
  unless you say `min-height: 0`**, and `overflow-y: auto` on a child
  that has stretched to its content is a scroll region with nothing to
  scroll.
- **A comment that explains why you did not do something names the thing
  you did not do.** Assert on comment-stripped source when the check is
  for an ABSENT declaration.
- **Anything `position: fixed` on `<body>` can paint over a dropdown
  regardless of the z-index you assumed.** Park it with a body flag.

Live geometry verified on both profiles: phone **393×660** (menu 52→578,
scrollable, all 5 sections reachable, "AI / Help" 24 px clear, "✨ Cool"
intact, Help Me 0 px overlap) and desktop **1440×900** (menu 56→835
inside a 900 px viewport, pill hidden while open).

Pinned by **`public_html/tests/control-chrome-collision.bun.test.js`**
(24 tests across 6 describe blocks). Suite: **943 pass / 0 fail**.

## Client-side vs server-side — what the measurements say (2026-11-06)

Owner ask: *"what else can we do to run things on client side rather
than server side to speed things up… ideally we only want to pass the
data to the client and have almost everything run on the client side"*.

**The honest answer is measured, and it is not the answer the wish
implies.** The rule that decides it is simple: **moving work to the
client only helps if the DATA is smaller than the work.** For this
dataset it is not — and the numbers say so exactly.

### The rivers: the data cannot come to the client

| | measured |
|---|---|
| the whole network, as GeoJSON | **~700 MB** (a 10° box alone is **28 MB**) |
| the network's reaches | **> 1,000,000** |
| one screen's vector data (WFS, by bbox) | **12.3 MB at z8, 26.8 MB at z5–z7** — and **8–13 s** to fetch |
| the same screen as raster tiles | **8 tiles in parallel, ~2 s each** → the screen is complete in **2–3 s**, and **~2 s** warm from the proxy's disk cache |

**So the raster WINS, and it wins because the server can render in
parallel and the client cannot.** Eight tiles at 2 s each is ~2 s of
wall time (six connections); one 27 MB vector request is 27 MB of
transfer and 8–13 s of server time, and the browser has to parse it
before it can draw a line. Passing the data to the client would make
this layer **slower, not faster** — and it would cost every reader the
bandwidth of the whole network the moment they zoomed in.

**The only thing the raster cannot do is carry ATTRIBUTES.** The
network has `ORD_FLOW`, `DIS_AV_CMS`, `LENGTH_KM`, `UPLAND_SKM`,
`CATCH_SKM` and `HYRIV_ID` on every reach, and a PNG has nowhere to
put them. That is a **small** query, not a big one — measured: a
**±0.02° box (4.4 km) returns ONE reach with all six attributes in
1.1 KB**, but the publisher still takes **3.8 s** to answer it (the same
fixed overhead as a tile). **Through the same proxy that would be a
~0.1 s click**, and it is the one thing worth moving to the client:
*click a river and read its discharge, its flow order and its
catchment*. **That is the recommended next step, and it is not built
yet** — it needs a second proxy route (a small-bbox WFS query) and a
probe box, and it is a real feature rather than a speed fix.

### What IS already client-side, and should stay that way

| | |
|---|---|
| **the river names** | 5,097 anchor points, **83 KB gzipped**, fetched only when the names are switched on — and the placement (one label per name, on screen, 70 px apart) runs entirely in the browser |
| **the legend key** | drawn from the published class table, so it cannot disagree with the map |
| **the detail level** | a URL, not a re-render of anything local |
| **the wind, the currents, the temperature, the HUD card** | the fields are downloaded once and **animated, probed, styled and exported in the browser** — the server never draws a frame |

### What the proxy changed about the balance

The proxy is **server-side** — deliberately. Its job is to make the
one operation that genuinely cannot move to the client (rendering a
million reaches) happen **once** instead of once per reader:

- the tile is fetched from the publisher **once** and cached **on
  disk**;
- every reader after that is a local file;
- the browser may keep it for a week.

**That is the shape of the answer: the server renders, the client
composes.** The layer the reader actually touches — the labels, the
level, the legend, the export, the HUD — is client-side; the picture
itself is a cached artefact the server produced once.

### The isobars: the METADATA cost more than the data (2026-11-10)

A second measurement of the same kind, from *"do a deep study on what
we can do to speed up isometric pressure bar loading"*. **The isobar
query itself was never the slow part** — the same SQL direct through
psql ran the whole route in **580 ms end to end** — but the route
wrapped it in **two full-table scans for METADATA** (~**474 MB of I/O**
per request: a 288 MB Seq Scan at 1,577 ms and a 186 MB Bitmap Heap
Scan at 606 ms), and it formed its **ETag after the query** because
the tag included `items.length` — so a **304 carrying an empty body**
cost **28,543 ms**.

**The fix is the same rule from the other side.** The *data* is small
enough to send (5.4 MB raw / 2.1 MB gzipped) and genuinely has to be
fetched, but the *metadata* about it is two orders of magnitude cheaper
to keep in the **2-row** `weather_isobars_build` publish record than to
recompute per request — and moving it to the client would not have
helped either, because the client cannot know what the server has
published without asking. Counts that still need the big table are
computed once per publish and cached against `built`; the ETag now
forms **before** the query.

**`x-response-time`, owner's own `step=0.1` view: 18,361 ms → 302 ms**
(warm: `stats=1 main=93–113 rest=37–73`), conditional request
**28,543 ms → 3 ms** (`main=skipped`). Full numbers and the three-part
fix are in the System Health row. The half this did **not** fix — a
16-hour idle-in-transaction session holding back VACUUM — was cleared
on 11-11 (**18,361 ms → 238 ms** once the table was compacted); the
leak behind it, `worker/learn.py` `fetchall()`ing ~3M JSONB rows, is
**Q-N30** and is still open.

### The general rule this suggests

For an overlay whose data is **large** (rivers, soil grids, climate
rasters, population), **cache the rendered tile at the edge and let the
client own everything else.** For an overlay whose data is **small**
(the labels, the probe grids, the wind grid, the pins), **send the
data and do the work in the browser** — which is what the site already
does. The rivers were the outlier: they had neither a cache nor a
small payload, and the proxy is the missing half.

## Hover HUD — what follows your cursor (2026-10-28)

A full study of every hover interaction on the map is in
**`docs/TOOLTIP_STUDY_2026-10-28.md`**. The short version: pins had no
text preview at all, probe boxes fought each other for the same patch
of screen, and nobody could choose what hover did.

The fix is one cursor-following card (`public_html/hover-info.js`)
with **three modes**, selectable in the control menu (⚙ → MAP → Hover)
and persisted in `localStorage["xyzo.hoverMode"]`:

| Mode | Pin hover | Coordinates | Layer readings |
|---|---|---|---|
| **Off** | — | — | layer probes behave exactly as before |
| **Pins** (default) | headline + place + time + sources card | — | layer probes as before |
| **Everything** | same card | lat/lng + zoom, always visible | one consolidated card: every **enabled, in-memory** layer sampled at the cursor (13 layers — see below) |

**"Everything" replaces, never stacks.** While that mode is on, the
layers' own hover boxes stand down (`HoverInfo.suppressesProbes()` —
checked in each layer's mousemove handler) so nothing fights the HUD.
Click-armed probes (basin, geology) are untouched: geology is a
network fetch and basins are a 650k-vertex ray-cast, so both keep
their deliberate Probe-button flow.

Each aggregating layer exposes **`sampleAt(latlng) → string | null`**;
the HUD only calls it when the layer reports `isEnabled()`. One bad
sampler cannot kill the card (each call is wrapped).

### The samplers (extended 2026-10-29; the HWSD soil type added 2026-11-05)

| Layer | Reading under the cursor |
|---|---|
| ⛅ **Pressure lines (isobars)** | `≈1008 hPa` — **interpolated between the two bracketing isobars** by inverse distance; a single nearby level reads `1012 hPa isobar`; sitting exactly on a line reads `1012 hPa` |
| 🌍 Köppen climate | class code + name (`Cfb · Temperate oceanic`) |
| 🌡️ Temperature (GFS) | `2.0 °C (35.6 °F)` — both units, always |
| 💨 Wind (GFS) | speed + direction (`from WNW · 12 kt`) |
| 🌊 Wave height & power | `Hs 2.1 m · Tp 9.4 s · 38 kW/m` — derived power from the same formula the worker publishes |
| 🟫 Soil (SoilGrids) | property value + class for the selected property |
| 🟫 **Soil type (HWSD v2.2)** | the WRB group under the cursor (`Soil: Cambisols`) — **added 2026-11-05**. Without it the reading **vanished** in "Everything" mode: the layer's own hover box stands down there, and with no HUD row to replace it the soil type was not on the screen at all |
| 🌾 Cropland / Land Cover (ESA) | dominant class + cropland share (`Cropland · 62% cropland`) |
| 🧭 Magnetic field (WMM) | declination, inclination and both annual changes |
| ⚡ Lightning density (WWLLN) | strokes km⁻² day⁻¹ at the cursor |
| 🦠 Phytoplankton (Darwin) | dominant type + biomass |
| ⛰️ Relief (ETOPO) | `1,234 m · 4,049 ft` — both units |
| 💧 Rivers | nearest **named** river within ~38 km (`Amazon · 12 km`) |
| 🗣️ Languages | nearest Glottolog point within ~28 km (`Aari`) |

**Isobars and rivers use SEGMENT distance, not vertex distance.** A
cursor sitting in the middle of a long contour segment is far from
every vertex — a vertex scan misreads "on the line" as "miles away",
which is exactly the case the HUD exists to answer. The isobar
interpolation likewise blends against the nearest segment of a
*different* level, so `≈1002 hPa` between the 1000 and 1004 lines is
the true midpoint pressure.

**Deliberately out:** geology (network fetch per point), basins
(650k-vertex ray-cast — click-Probe only), and the image-only
overlays (salinity, ocean currents, Facebook friendships,
transportation) — they hold no numbers to read.

### Per-layer on/off (2026-10-29)

While the mode is **Everything**, the control menu shows a checkbox
list (`#hover-sampler-list`) under the Hover picker — one row per
sampler. Unticking a row silences that layer's reading without giving
up the card; the choice persists in
`localStorage["xyzo.hoverHudOff"]` (a JSON array of window names).
The list is wired once with a delegated `change` listener and re-rendered
only when a toggle flips. The HUD itself stays `pointer-events: none` —
the checkboxes live in the menu, never on the card.

The canvas renderer feeds the HUD via a `xyzo:pin-hover` CustomEvent,
reusing the hit-test it already runs for the hover ghost — no second
hit-test per mousemove. The HUD hides while the map is being dragged.

Pinned by `public_html/tests/hover-info.bun.test.js` (module contract,
all 13 samplers exposed, per-layer toggle round-trip, expensive layers
excluded) plus each layer's own `sampleAt` tests (isobar interpolation
worked out on paper, river/language nearest-neighbour thresholds,
malformed-data guards).

## The Probe — one readout, under the cursor (2026-11-04)

The full study is in **`docs/PROBE_STUDY_2026-11-04.md`**. The short
version: every layer that has a number under the cursor drew its **own**
box and placed it at `containerPoint + 14px` — **the same 14px** — so
with the wind, the wind speed and the climate all on, three boxes landed
on the same spot and covered each other. Measured on the live map
(pointer at 800,500):

```
.wind-probe        [814, 514, 196, 44]   "2.3 m/s · 8 km/h · 4 kt   from SE (145°)"
#wind-speed-probe  [814, 514, 139, 26]   "2.4 m/s · 9 km/h"          <- ON TOP
.climate-probe     [914, 574, 205, 30]   "Aw  Tropical - Savannah"    <- ON TOP
```

The **hover card** had the same fault — it placed *itself* at "cursor +
14px" too, so hovering a story pin showed the card on top of the wind
and climate readings.

### One positioner

`public_html/probe-stack.js` is now the **only** thing that decides
where a readout sits:

* the column starts at **cursor + 14px** (the house offset) and each box
  is placed **3px** below the previous one;
* a box that would run off the **right** edge flips to the **left** of
  the cursor;
* a column that would run off the **bottom** flips **above** the
  cursor;
* the **hover card is the top of the column**, so it never covers a
  layer's reading.

**Two coordinate systems, handled explicitly.** The layer probes are
`position: absolute` inside the **map container** (container points);
the card is `position: fixed` on `<body>` (viewport points). The
stacker writes each back in its own system — a stacker that used one
for both would put the card a container-width off.

**The layers keep their own boxes.** A climate probe carries a colour
swatch, a wind probe a compass point, the temperature probe a °C/°F
pair, and the ARMED (tap-to-read) probes are a deliberate single-layer
action with their own life cycle. Merging eleven layers into one card
would have cost all of that to fix a problem one positioner solves.

### One wind reading, not two

The wind-SPEED field is the **magnitude of the wind animation's own
u/v pair** — the same air. It used to compute that magnitude on a
**pre-derived grid**, and `bilinear(u,v) → hypot` is **not**
`bilinear(hypot(u,v))` — so the two layers printed **2.3 m/s and
2.4 m/s** for the same air on the same screen.

* it now samples the **same vector** the animation samples
  (`WindLayer.sampleVector`), so the number is identical to the digit;
* and it **stands down** when the animation is on, because the
  animation's probe already carries the speed *and* the direction.

The speed field was also **missing from the hover card entirely** (it
was never in `SAMPLERS`), so with the animation off and the speed field
on, "Everything" mode said nothing about the wind at all.

### The units

Owner ask: *"remove m/s and add miles/hr and kt and km/hr"*. **m/s is
gone from every reader-facing wind reading** — the probe, the hover
card and the legend's scale labels now read `14 mph · 22 km/h · 12 kt`.
**m/s stays the DATA unit** (the published grid, the colour ramp and
the export band names `wind_u_m/s` / `wind_v_m/s`), because they must
stay in the unit the source speaks — only the display converts. The
**ocean-current** layer still reads m/s: a current is a different
quantity from a wind and m/s is its SI convention.

### How it is kept true

`scripts/probe_audit.py` drives a real browser, sweeps the pointer over
51 positions and checks three things: **no two readouts overlap**,
**nothing runs off the screen**, and **every wind reading matches the
published grid** — which it samples independently in Python, so the
check is not the layer grading its own homework. It exits non-zero when
it finds a problem.

Tests: `public_html/tests/probe-stack.bun.test.js` (10) — the list of
probe classes the stacker knows (a probe class it does not know about
is a box that is never stacked), the edge flips, the two coordinate
systems, the load order and the cache stamp — plus
`wind-physics.bun.test.js`, which pins the units and asserts that
**m/s is gone**.

### The isobar ANALYSIS picker

Separate but related: see **"the pressure lines differ from windy.com"**
in the System Health table above. The API has always supported
`source=ecmwf|gfs|hrrr` and the reader had **no way to ask for one**;
there is now a chip row (**Auto · ECMWF · GFS · HRRR**) under the
isobar legend's detail and colour rows, and the choice travels with the
link (`/isoSrc=ecmwf`), the saved style and the presets.

## Text Size, Double-Click Submit & Saved Styles (2026-10-29)

Three accessibility affordances, one owner spec: *make the map usable
for elderly readers who were accidentally opening the submitter and
could not read the small text.*

### 🅰️ Text size — A / A+ / A++ (default A+)

The control menu (⚙ → MAP → Text size) offers three steps. The
default is **A+ (115 %)** — "a little larger anyway" — and the
preference persists in `localStorage["xyzo.textSize"]`.

- An **early `<head>` script** applies the stored class *before first
  paint*, so the page never flashes at the wrong size.
- The scale drives a CSS variable (`--ui-zoom`) used with `zoom` on
  **inner content only**: the live-panel header/list/status, popup
  content, explore/help panels, submitter card, dropdown menus and
  the bottom nav.
- **The positioned boxes are never zoomed themselves.** `zoom`
  multiplies every specified length on the element — including
  `top: var(--panel-top)`, `height: calc(100vh …)` and a centered
  `transform: translateX(-50%)`. Zooming `.live-panel` itself would
  push it down and past the viewport; zooming `.bar-dropdown` would
  slide it off centre. Zoom the children, keep the parents in
  unscaled pixels.

### 🖱️ Double-click to submit (single click = hint only)

A single tap on empty map used to open the full submitter — elderly
users hit it by accident constantly. Now:

- the **first click** leaves a small chip — "Double-click to add a
  story here" — which fades after ~2 s (the chip is
  `pointer-events: none`, so it can never swallow the second click);
- only a **second click within 500 ms and 40 px** opens the form;
- the map's own `doubleClickZoom` is **disabled** (`L.map` options) —
  the gesture is exclusively "add a story"; zoom stays on the wheel,
  the pinch and the +/- buttons;
- **probe-armed single clicks are unaffected**: every layer's
  `blocksClick()` guard sits BEFORE the gate in the click chain, so
  arming a probe and tapping still reads the data in one click.

### ☆ MY STYLE — save / restore a whole view

The control menu (⚙ → MY STYLE) captures everything that makes a view
*yours* — position, zoom, base layer, and every overlay with its
opacity — in one click, and brings it back in one click.

- **Save** snapshots the current state (up to 8 styles, newest first,
  `localStorage["xyzo.savedStyles"]`). The button flashes "✓ Saved".
- **Restore** first removes every active overlay the style does NOT
  contain, then replays the snapshot through
  `applyLayersFromParsedHash` — the SAME path a shared URL uses, so a
  saved style and a pasted link can never diverge. The isobar layer
  (not a `WEATHER_OVERLAYS` entry) gets its own disable, mirroring the
  hash-apply special case.
- Each saved row shows `29 Oct 14:35 · 5 overlays` with a × to delete.

Pinned by `public_html/tests/interaction-prefs.bun.test.js`.

### ✨ Cool maps · ⭐ default map · ↺ Clear (2026-10-30)

`public_html/map-presets.js` (`window.MapPresets`) answers "what map do I
see when I get back?" It is **pure state + storage** — it never touches
the live map. `app.js` owns the two halves that do (`captureMapState()`
/ `applyMapState()`), so every restore route — preset chip, ⭐ default,
last-used, shared URL — is ONE route.

**The presets are real hashes, not parallel config.** Each preset's
`hash` is in the exact `getMapHash()` grammar, parsed by a local mirror
of `parseMapHash()`:

```js
{ id: "portrait", tier: "high", icon: "🌍", name: "🌍 Earth portrait",
  hash: "#2.1967,16.8750,3/density=max/overlay=wind-gfs@100,basins@100,…,nasa-rain@30,etopo@55/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed" }
```

- **`🌍 Earth portrait` (id `portrait`) is the FIRST-VISIT SHOWCASE** —
  `COOL_ID = { high: "portrait", low: "plain" }` picks it by machine
  tier, and `bootPlan()` hands it to `applyMapState()` when nothing is
  stored. **Its hash is the owner's own, pasted verbatim** (11-08,
  superseding the 11-04 version): **fifteen overlays** — the wind
  animation over the wind SPEED field, the isobars at **0.25 hPa off
  GFS**, Köppen, SoilGrids, the soil TYPE (HWSD), WorldPop population,
  ESA cropland and land cover, ETOPO relief, the rivers and the basins,
  the tectonic faults and the NASA rain. **Changing what a first-time
  reader sees is a ONE-LINE change** — the `hash` above, plus the
  `COOL_ID` table right below it.
- **`🛰️ Satellite` (id `plain`) is what a SLOW MACHINE opens** (11-14) —
  `#19.9733,0.0000,2/density=medium`, **no overlays at all**. It was
  `🌱 Climate skin` (Köppen + the city names), and that was **not
  light**: the city names alone pull the 1.16 MB city index. The owner
  asked for *"a low rez version without any overlays except the
  satellite view"*. **MEDIUM pins, not max** — the pins are the heaviest
  thing a slow machine fetches (3,000 at max, 1,500 at medium).
- **A CHIP CLICK SWAPS THE LAYERS AND KEEPS THE CAMERA** (`keepView`),
  by the owner's rule of 11-01 (*"keep the perspective and zoom level
  and just update the selections"*). The **first load** has no camera to
  keep, so it opens at the preset's own centre and zoom.
- **THE CHIPS WRAP — THEY USED TO RUN OFF THE PANEL ON A PHONE.** The
  chips are ONE flex line, so their width is the **sum** of the chips'
  widths, and the layers panel is **335 px** on a 393 px phone.
  **Measured: ten chips were 417 px and the eleventh made it 459 px** —
  the last chip's right edge at **435 px** against a panel that ends at
  **353 px**, so the last two or three chips were **cut off and
  unreachable on a phone**. `flex-wrap: wrap` puts them on a second line
  instead (and `min-width: 0` lets the row shrink inside the flex parent
  that holds it): **after, the row is 330 px inside the 335 px panel**
  and all eleven chips are inside the panel **and** hit-testable.
- **The preset's hash can name the four STYLE settings** — the isobar
  step, the isobar colour, the isobar analysis and the wind's
  style/colour — and the owner's map names all of them
  (`iso=0.25:pressure`, `isoSrc=gfs`, `wind=particles:speed`).
- **`🛣️ Street mode` (id `street`, added 11-01) is the owner's own
  favourite** and the **first preset with a non-satellite base layer**
  (`base=street` → OpenStreetMap): street base under ETOPO relief 45 %,
  SoilGrids 30 %, ESA cropland 45 %, ESA land cover 20 % and a 5 %
  Köppen wash, pin density Max. It exercises the `base=` half of
  `parseHash()`/`applyMapState()` that the original six never touched;
  its hash is pinned verbatim in the test suite.
- **Every overlay slug in a preset must be an EXPLICIT `LAYER_SLUGS`
  key** (this shipped with `wind`, `cape`, `ivt`, `koppen`, `climate`
  added). `resolveLayerName()` falls back to a substring scan over the
  overlay names, which resolves by luck — a preset pinned to a name a
  later rename changed would silently apply *nothing*, and no screenshot
  would ever catch it. A test walks every preset and fails on a slug the
  table does not carry.
- **`applyMapState` runs the removal half** (via `applySavedStyle`)
  before the adds. Without it a "Clear" would not survive the layer
  modules that restore themselves from their own `localStorage` keys on
  boot — they would re-add themselves after the clear.

**First visit is hardware-gated.** `deviceTier(nav)` returns `"low"` on
save-data, 2G/3G, <4 cores, <4 GB (when `deviceMemory` is reported at
all), and demotes a <480 px screen unless it admits ≥8 GB (phones
thermally throttle into a stuttering first impression). "high" opens
`🌍 Earth portrait` — **the owner's own fifteen-overlay map**;
**"low" opens `🛰️ Satellite` — the bare satellite view, NO OVERLAWS**
(it was `🌱 Climate skin` — Köppen PNG tiles and city names — until
2026-11-14, and that was **not light**: the city names alone pull the
1.16 MB city index. The owner asked for *"a low rez version without any
overlays except the satellite view"*, and the pins are at **medium**
rather than max, because the pins are the heaviest thing a slow machine
fetches — 3,000 at max, 1,500 at medium). The "high" first visit is
**25.8 MB / 395 requests**, measured with the resource-timing buffer
raised (the browser's default 250-entry buffer **drops the rest** and
under-reports the payload by half) — see **Q-N0** for the breakdown and
what is being done about it. **The satellite first visit, measured the
same way in a settled browser: 130 requests / 2.6 MB against the
showcase's 250 / 4.7 MB** (`scripts/default_map_check.py`).

**Boot precedence — a shared link is an instruction, not a preference:**

```
URL #hash  →  ?base=&overlay=  →  ⭐ default  →  last-used  →  cool preset
```

`_restoreMapView()` consults `MapPresets.bootPlan(navigator)` only after
both URL paths, and the plan itself reads *default → last → cool* (with
`mode: "cool"` overriding the default, and a vanished default falling
back to last-used). Storage keys: `xyzo.defaultMapState`,
`xyzo.lastMapState`, `xyzo.nextVisitMap` (`auto` | `saved` | `cool`).

**The auto-save hooks `updateUrlHash()`, not a list of map events.**
Every state change (move, layer, opacity, density, base) already rewrites
the hash, so that is the one choke point — debounced 1.2 s, and flushed
on `pagehide`, because a tab closed inside the debounce window must not
keep yesterday's state.

**Two traps in the stored state:**

- **A state with nothing in it must never be applied.** `sanitizeState()`
  returns `null` for `{}` — `applyMapState({})` would run the removal
  half and strip every overlay off the map. An explicit `overlays: []`
  (a deliberately cleared map) still counts as meaningful.
- **Reset cannot read a layer's default off the layer.** Leaflet's
  `setOpacity()` writes into `options.opacity`, so the moment a slider
  moves the original is unrecoverable. `OverlayOpacity` therefore
  captures each layer's own value in `captureDefaults()` when
  `restore()`/`mount()` first see the table, and `reset()` replays
  those. The isobar row lives outside the overlays list, so `resetMap()`
  handles it itself (0.85).

**Clear vs Reset.** `↺ Clear` removes every overlay and keeps the base
layer and the camera (`applyMapState(..., { keepView: true })`). `⤢ Reset`
is factory state: world view, Satellite, no overlays, captured default
opacities, density Medium. Both live in the layers dropdown as a
`.leaflet-presets-row` **sibling** of the base/overlay lists (Leaflet
empties those two on every layer change — same contract as the
links/markers rows).

**`map-presets.js` and `overlay-opacity.js` are stamped per-file** by
`bash scripts/bump_asset_token.sh <file> [stamp]`, and are deliberately
NOT in `bump_frontend.sh`'s `ASSETS` — a one-file change must not bust
the whole page's cache. The script stamps `index.html` AND `globe.html`
(if the asset appears there) and, for `globe.js`, its internal
`const V` data token.

Pinned by `public_html/tests/map-presets.bun.test.js` (29 tests — the
module is executed against a stubbed `localStorage`, not just grepped).

## Daily Digest & News Video (2026-10-23)

The map can publish a **daily briefing**: the day's most *interesting* stories,
curated, written up, mapped, narrated and uploaded to YouTube.

The **digest** is the product; the video is a renderer of it. The digest is a
reviewable JSON artifact — what a reader sees and what the video says can
never drift apart.

```
worker/daily_digest.py  →  data/daily_digest.json  →  GET /api/digest/today
                                    │
                                    ├── public_html/digest-panel.js   (the "Today" panel on the map)
                                    └── worker/digest_render.py → storyboard.json → mp4
                                              └── worker/digest_upload.py → YouTube
```

### What "interesting" means

"Top news" is whatever has the most articles — usually wire copy of a story
three days old. The digest scores **events** (not articles) on measured
signals, then lets the local model write the words:

| Signal | What it asks |
|---|---|
| `acceleration` | rising, not just big |
| `corroboration` | independent credible outlets, not one story copied 40 times |
| `momentum` | overall velocity (`news_event_velocity`) |
| `spread` | how many countries the story reached |
| `novelty` | fresh, not day four of the same thing |
| `undercoverage` | big and thinly reported — nobody is covering this |
| `graph` | connected to other events in the story graph |
| `independence` | not syndicated wire copy |

Then three gates decide what runs: the **world test** (≥4 credible outlets
and either ≥2 countries or ≥8 outlets), an **editorial category filter**
(conflict / politics / climate / economy / tech / health / science — culture
and "other" are not front-page material), and a **variety pass** (at most 3
per category, 2 per country, 4 per region). The model writes the *why* and
the narration and may veto a story — but it never chooses what runs.

### Running it

```bash
# 1. curate the day (writes data/daily_digest.json)
XYZO_DB_DSN="postgresql://…" python3 -m worker.daily_digest --print

# 2. render the video (needs the site up; writes data/digest_video/)
python3 -m worker.digest_render --dry-run      # storyboard only
python3 -m worker.digest_render                 # frames → ffmpeg → mp4

# 3. upload (needs YouTube OAuth in the env file — see the module docstring)
python3 -m worker.digest_upload --status
python3 -m worker.digest_upload
```

### The video

`public_html/digest-render.html` is a purpose-built render page (dark map,
title card, lower third, location marker) that Playwright drives one beat
at a time; `digest_render.py` captures a frame per beat and assembles them
with ffmpeg. The voice track is added by the narration step (piper is
installed locally — free, offline, no API key).

Uploading needs a YouTube OAuth refresh token for the target channel. It is
a credential, so it lives in `/etc/xyzo/xyzo.env`, never in the repo:
`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`.

> ⚠️ YouTube requires creators to disclose realistic synthetic content — the
> description says the narration is machine-generated. The same description
> credits the outlets the stories came from; never lift broadcaster audio
> into the upload.

---

## The "Help Me" AI Chat (2026-10-23)

The floating 🆘 button on the map opens a chat that answers "what's
happening, and what can I actually do about it?". The widget is
`public_html/help-me-chat.js`; the AI itself lives on **hivv.org** (this box
runs the gateway on `:3011`), so the whole chain is:

```
help-me-chat.js ──POST /api/ai/chat──► xyzo-api :3008 ──► hivv gateway :3011
                     (api/src/routes/ai-chat.ts)              (local bees)
```

Four rules keep it honest — every one of them was a bug that made the chat
look broken:

1. **Real roles, not a flat transcript.** The payload is
   `{system, messages:[{role,content},…]}`. The persona + location + stories
   are a *system* message; the conversation is real user/assistant turns.
   Flattening it into `User: …\nAssistant: …` made the model continue the
   pattern (it answered with `User: why not?Assistant:`) and made a bad
   answer self-perpetuating. The API still accepts the legacy single-string
   `{message}` shape so cached browsers keep working.

2. **The question appears exactly once.** The prompt is built *before* the
   current turn enters the transcript — otherwise the model read `User: hi`
   twice and answered the duplicate.

3. **A refusal is not an answer.** Small models in the hive pool answer a
   benign question with a canned safety refusal ("I'm sorry, but I can't
   assist with that."). The API detects that shape, re-rolls the gateway's
   model lottery, and only returns `502 ai_refused` if every model declines.
   The widget never stores a refusal in the transcript — if it did, the next
   prompt would quote it back and the model would refuse again (a sticky loop
   that made the chat look permanently broken).

4. **Pin the model.** `XYZO_AI_MODEL=gemma-4-E2B` — the gateway restricts
   local candidates to bees advertising a matching model. Without the pin the
   routing lottery could hand the request to a 0.5B model that 500s, takes
   200 s, or refuses.

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `XYZO_AI_PRIMARY_URL` | `http://localhost:3011/v1/chat/completions` | hivv.org gateway |
| `XYZO_AI_FALLBACK_URL` | `http://192.168.1.3:8888/v1/chat/completions` | direct local Gemma |
| `XYZO_AI_MODEL` | `gemma-4-E2B` | model pin — keep it matching an advertised bee model |
| `XYZO_AI_TIMEOUT` | `25000` | per-attempt budget (ms) |
| `XYZO_AI_MAX_TOKENS` | `512` | answer cap — the 2B models otherwise write ~2000 tokens (≈60 s) |
| `XYZO_AI_ATTEMPTS` | `2` | model-lottery re-rolls when a model refuses |
| `XYZO_AI_TEMPERATURE` | `0.7` | |

> The gateway used to **drop** `max_tokens`/`temperature` for local bees
> (`chatCompletion` never forwarded `gen` to the router), so every chat turn
> generated up to 2048 tokens. Fixed in `hivv.org/api/lib/router.js` — the
> cap now reaches the node and a turn takes 2–8 s instead of 15–60 s.

---

## Testing

### What covers the 2026-11-09/10 changes (the search, the saved searches, the layer keys)

| Change | Test | What it pins |
|---|---|---|
| The search frames the **stories**, not the geocoder's guess | `public_html/tests/search-region.bun.test.js` (30) | a point of interest is not a region ("artificial intelligence" → not the Würzburg front door); the region comes from the raw story locations; a worldwide set gets the world view; a location row must be corroborated by the geocoder; the accents are folded; the framing happens BEFORE the slow query; the helpers |
| A place still wins (the pre-existing rule) | `public_html/tests/search-place-navigation.bun.test.js` | the place gate, the extent cap, the box-centre agreement — the same assertions, read out of the shared `frameSearchRegion()` |
| A repeat search is instant | `public_html/tests/saved-searches.bun.test.js` (21) | the store itself, against an in-memory IndexedDB: a round trip, the key, the age limit, the pruning to 12, and a browser with no storage (no crash); plus the ordering, the framing, the slimming and the server's byte budget |
| A short query matches a **whole word** | `api/tests/pins-search-wordmatch.test.ts` | the real route: "Nvidia unveils a new AI chip" is found, "the minister **said** the heavy **rain**" is not — **mutation-checked** (it fails against the pre-fix code) |
| A structural artefact is not a topic | `api/tests/tags-structural.test.ts` | `/api/tags/top` offers "politics" and not "topic"/"tags"/"short"/"3-6" — **mutation-checked** |
| …and never reaches the table | `worker/tests/test_extract_topic_tags.py` (9) | the extractor strips the four words, falls back to the event type, and caps at six |
| The server's cache is byte-budgeted | `api/tests/cache.test.ts` (14) | the budget evicts the oldest, one over-budget entry is still kept, replacing a key does not double-count, an expired entry gives its bytes back |
| The layer keys are **readable** | `public_html/tests/hwsd-layer.bun.test.js` (+5) | the key must not use `var(--fg)`, the names are ≥12px, the swatches have an edge, no name is cut off, the key is revealed on enable |
| …measured, not asserted | `scripts/legend_contrast_check.py` | every key in the dropdown, every text element, against the background actually painted behind it — fails under 4.5:1 or 11px |

**Test inventory (2026-11-04)**

| Suite | Count | Command | Baseline |
|-------|-------|---------|----------|
| Mobile (bun) | 21 | `bun tests/test_mobile_pins.js` | **21 pass / 0 fail** |
| Frontend (Bun) | 77 files | `bun test public_html/tests/*.bun.test.js` | **1358 pass / 0 fail** |
| API (Bun) | 46 files | `cd api && bun test tests/<file>.test.ts` | run per file — the suite truncates shared tables, so parallel files race |
| Worker (pytest) | 47 files | `python3 -m pytest worker/tests/ -q -m "not network"` | **968 pass / 9 pre-existing failures** |
| Python (pytest) | 34 files | `python3 -m pytest tests/ -q` | see `pytest.ini` |

The 9 worker failures are the documented set (ai_client ×2,
news_source_addition DB-sync ×3, service_events_api ×2,
source_quality, location_id_backfill) — environment and schema-drift
issues, not regressions. Run with `-m "not network"` for the stable
picture: the network-marked tests (windmap's NOMADS/Open-Meteo
cross-checks, live fetches) depend on third-party uptime and skip or
flake when it is down. Two `test_auto_categorize` teardowns can also
hit a DB statement timeout under a loaded box — the tests themselves
pass on rerun. **A new failure in the stable set is a regression.**

The frontend suite is fully green as of 2026-10-28 (478/478) — the
old baseline set (stale `#reload-pins-btn` / `#share-btn` / MODE_BUTTONS
tests, mobile bottom-bar touch targets, the `app.js` size gate, the
eager-load audit) has since been repaired or retired. **A new failure
is a regression.**

### Data-dependent tests use synthetic fields, never the live grid

`wind-physics.bun.test.js`'s directional tests (`an easterly wind moves
a particle east`, `a southerly wind moves a particle south`) sample a
**synthetic uniform wind field** (`makeSandbox({uniform: {u, v}})`), not
the live GFS grid. The 6-hourly `xyzo-windmap` refresh moves the real
wind at a fixed coordinate — pinning one cell's direction broke the
moment the cycle shifted it (the southerly test flapped on 2026-10-29).
The physics is what is under test; the field is an input. If you add a
directional test, pass `uniform`.

New suites worth running after touching their feature:

```bash
bun test public_html/tests/hover-info.bun.test.js        # the hover HUD + mode picker
bun test public_html/tests/interaction-prefs.bun.test.js # text size, double-click submit, saved styles
bun test public_html/tests/frontend-hygiene.bun.test.js  # app.js rot: shadowed decls, unstamped assets, console.*
bun test public_html/tests/overlay-contracts.bun.test.js # every overlay's boot + pane + opacity + blocksClick contract
bun test public_html/tests/city-labels.bun.test.js     # city labels: CityEngine reuse, pop floors, collision, no-click-block
bun test public_html/tests/etopo-layer.bun.test.js      # relief: palette seams, hillshade math, verify-calibrated probes, m/ft
bun test public_html/tests/languages-layer.bun.test.js  # languages: points not polygons, probe lists all, verify probes
bun test public_html/tests/markers-off.bun.test.js     # layers panel: markers toggle, stay-open, ✕ close, pin dismiss
bun test public_html/tests/mag-layer.bun.test.js       # magnetic field: S_L contouring, ramps, blackout, probe
bun test public_html/tests/transport-layer.bun.test.js # NOAA Anthropocene composite: tileLat wrap, async done, overlays entry
bun test public_html/tests/ocean-layer.bun.test.js     # ocean currents: same GridLayer contract + image warm-up
bun test public_html/tests/basin-layer.bun.test.js       # basins overlay + colour schemes
bun test public_html/tests/globe.bun.test.js             # the 3D globe (settings, popups, zoom-bar)
bun test public_html/tests/overlay-opacity.bun.test.js   # sliders + hash
cd api && bun test tests/story-tree.test.ts              # the tree endpoint
```

### Overlay contracts (2026-10-28)

`public_html/tests/overlay-contracts.bun.test.js` pins the rules that
keep the layers dropdown and the boot path alive. Run it whenever you
touch any overlay:

```bash
bun test public_html/tests/overlay-contracts.bun.test.js \
        public_html/tests/overlay-opacity.bun.test.js
```

What it locks down:

- **Every** overlay object returned to `WEATHER_OVERLAYS` provides
  `setOpacity` (the RiverLayer GeoJSON crash of 2026-10-28: a missing
  method threw inside `OverlayOpacity.mount`, aborted `app.js` before
  `const pinMarkers`, and killed the map).
- `overlay-opacity.js` guards **every** `setOpacity` call with
  `typeof layer.setOpacity === "function"` — a hostile layer degrades,
  it does not throw. Pinned at runtime with a stubbed DOM: `mount()`
  with `{}` as a layer must not throw, and the well-behaved neighbour
  still gets its value.
- Boot order: every module loads before `app.js`, is stamped by
  `bump_frontend.sh`, and is `init`-ed after the map exists — all
  guarded by `typeof window.X && typeof window.X.init === "function"`.
- Probe modes (`SoilLayer`, `CroplandLayer`, `ClimateLayer`,
  `TempLayer`, `MagLayer`, `BasinLayer`, `GeologyLayer`, `EtopoLayer`)
  return `blocksClick() === true` while armed so a tap reads instead of
  opening the submitter; **rivers and city labels never block clicks**.
- Pane z-indexes: relief 345 < waves 346 < climate 350 < salinity 351 < soil 352 <
  cropland 353 < geology 354 < temp 355 < lightning 356 < lang 357 <
  mag 358 < transport 359 < isobar 360 < ocean 361 < basins 362 <
  river 365 < wind 370 < city labels 380, all under the pins at 400.
- Tile-backed layers carry a `BUILD` token on their PNG URLs (PNGs are
  Caddy-immutable for a year; a rebuilt pyramid behind a stale token is
  invisible). **Hotlinked** layers (Macrostrat geology) carry no BUILD
  token — pinned as a negative so nobody adds one by reflex.
- Soil defaults to **WRB groups** and falls back through the property
  list if a pyramid isn't published yet; the probe refuses a
  half-downloaded `grid.bin`.
- Cropland builder invariants: full per-slot alpha array (not
  `bytes([0])`), outward-rounded warp windows, valid-only blit, and the
  `(30, 10)` probe-grid reshape.
- River builder invariants: ranks 1–12 all styled, every rank visible by
  zoom 6, labels rank-gated and capped.
- Geology invariants: Macrostrat tiles must use the **default 256**
  `tileSize` (a `tileSize: 512` override stretches the overlay because
  Macrostrat's 512 px PNGs use the standard XYZ grid); `maxNativeZoom:
  14`; the USGS contacts WMS className is CSS-inverted to white; and
  the probe queries the Macrostrat point API debounced and cached.
- **2026-rivers invariants: the tile grid is the STANDARD 256-px slippy
  grid, and the IMAGE is 512 px** — `tileSize` stays at the default
  because Leaflet's CRS scale is fixed at `256·2^z`, so a 512-px layer
  asks for a 512-px grid and every tile is then fetched from the wrong
  quadrant of the world (the rivers appeared over the Indian Ocean out
  of Greenland). The sharpness comes from the image instead: the
  publisher renders the standard square at 512×512 and the browser
  downscales it into the 256-px slot. Every tile URL carries a `?v=`
  build token (a `*.png` under `public_html` is `immutable` for a
  year), the static pyramid covers z0-z4 and the proxy covers z5+, and
  the four detail levels are four DIFFERENT pictures.
- **Hash/localStorage restore ordering**: any module that restores a
  persisted on/off state by calling `addTo(map)` in `init()` must
  register its `overlayadd`/`overlayremove` listeners **first** —
  `addTo` fires `overlayadd` synchronously, and a listener attached
  later never sees the restore (the MagLayer "checkbox on, field
  missing" bug of 2026-10-28). app.js must also record the overlay
  name in `_activeOverlayNames` unconditionally in the hash restore,
  not only when it performs the `addTo` — otherwise a module whose init
  already put the layer on the map from localStorage gets dropped from
  the next hash rewrite. Pinned across all four restoring modules.
- The Caddy `@missingTile` fallback exists and points at
  `data/empty-tile.png`.

`overlay-opacity.bun.test.js` additionally runs the module **for
real** (stubbed `document`/`localStorage`) and asserts `set()`/`get()`
round-trip through storage.

### Always Run Before Deploying

```bash
# Validates everything (API, frontend, E2E)
bash scripts/validate-api.sh

# API health check — tests critical endpoints against baseline
bun run scripts/api-health-check.js

# After touching the frontend: stamp every asset with one build token
bash scripts/bump_frontend.sh
```

> ⚠️ **Always bump the frontend `?v=` token.** `index.html` loads
> `styles.css` asynchronously and the scripts with a `?v=` stamp; a stale
> token means cached browsers keep running the old code. That is how the
> Köppen entry was missing from the layers dropdown for a week (the file
> changed on 2026-10-22, the token did not). `scripts/bump_frontend.sh`
> stamps every `index.html` asset (styles, app, all overlay layers,
> overlay-opacity, digest-panel) **and** the globe page's assets
> (`globe.js`, `globe.css`, the vendored MapLibre bundle, and globe.js's
> internal `V` constant) with one token.

### API Health Check

The API health check (`scripts/api-health-check.js`) tests the critical endpoints for liveness and response validity. It stores a baseline of expected responses and fails if any endpoint's response changes.

> An endpoint that could not be measured (a slow one under load) now **keeps
> its previous baseline entry** instead of silently dropping out of the
> baseline — otherwise a busy box quietly shrinks the safety net.

```bash
# Check against baseline
bun run scripts/api-health-check.js

# Update baseline (when intentionally changing endpoints)
bun run scripts/api-health-check.js --update

# Force update even if some endpoints fail
bun run scripts/api-health-check.js --force
```

**Tracked endpoints:** `/api/health`, `/api/stats`, `/api/pins/stats`, `/api/pins/map`, `/api/cities/search`, `/api/sources/stats`, `/api/story-links/stats`, `/api/coolness/top`, `/api/coolness/surging`, `/api/coolness/coolness-stats`, `/api/locations/search`

### BigInt Prevention

**PostgreSQL `COUNT(*)`, `AVG()`, `MAX()`, `MIN()` return BigInt** which JavaScript cannot serialize. Always use casts:

```sql
-- Use ::float for COUNT and most aggregates
SELECT COUNT(*)::float AS total FROM news_sources;

-- For AVG, use ::float
SELECT AVG(coolness_score)::float AS avg_score FROM city_coolness;
```

**In route handlers:**
```js
// WRONG — BigInt serialization error
const [row] = await sql`SELECT COUNT(*) AS total FROM ...`;
return c.json({ count: row.total });  // BigInt!

// RIGHT — explicit float cast
const [row] = await sql`SELECT COUNT(*)::float AS total FROM ...`;
return c.json({ count: Math.round(row.total) });  // Number
```

If you see `"JSON.stringify cannot serialize BigInt"`, the fix is to add `::float` casts to your SQL queries.

### Frontend Tests (Bun) — 169 tests

```bash
# Run all frontend tests (must use the *.bun.test.js glob — plain
# `bun test public_html/tests/` also picks up browser-only *.test.js
# files that reference `window` and abort the run)
bun test public_html/tests/*.bun.test.js

# Run specific test file
bun test public_html/tests/category-filter.bun.test.js
```

**Frontend test categories:**
| File | Tests | What it tests |
|------|-------|---------------|
| `syntax-validation` | 15 | JS syntax validation |
| `taxonomy-integrity` | 15 | Category taxonomy |
| `new-code-guard` | 13 | Code guard tests |
| `category-filter` | 13 | Category filter UX |
| `mobile-icon-canvas-sync` | 13 | Mobile rendering |
| `mobile-popup-autoclose` | 11 | Popup behavior |
| `code-splitting` | 10 | Lazy loading |
| `mobile-pin-bug` | 10 | Pin display |
| `mobile-bottom-bar` | 8 | Mobile UI |
| `a11y` | 6 | Accessibility |
| `layer-toggle-regression` | 5 | Layer toggles |
| `mobile-close-popup-regression` | 4 | Close behavior |
| `climate-layer` | 16 | Köppen overlay wiring, the class key, the cache-buster |
| `overlay-opacity` | 7 | Per-layer opacity sliders |
| `layers-dropdown` | 5 | What lives inside the layers dropdown |
| `map-first-load` | 5 | The map must be visible on a cold first load (Firefox) |

### Worker Tests (pytest) — 886 passing

```bash
# Set up database connection
export XYZO_DB_DSN="postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"

# Run all worker tests
python3 -m pytest worker/tests/ -v

# Run specific test
python3 -m pytest worker/tests/test_worker_health.py -v
```

### Test Categories

| Suite | Command | Speed | What it tests |
|-------|---------|-------|---------------|
| API | `bash tests/run_tests.sh api` | ~35s | Route handlers |
| Python | `bash tests/run_tests.sh python` | ~20s | Unit tests |
| Worker | `bash tests/run_tests.sh worker` | ~60s | Full pipeline (needs DB) |
| Browser | `bash tests/run_tests.sh browser` | varies | Playwright E2E |
| Quick | `bash tests/run_tests.sh quick` | ~30s | Fast subset |

**Failure Types:** REAL_BUG (fix before deploy), SCHEMA_DRIFT, FLAKY, SETUP_ERROR, TIMEOUT, NETWORK

---

## Performance & Usability Audit (2026-10-29)

Measured on the live site with real Playwright browsers — an iPhone 13
profile (390×844, DPR 3, touch, real user agent) and a 1440×900 desktop.

| Metric | Desktop | Mobile |
|---|---|---|
| DOMContentLoaded | 2,178 ms | 1,046 ms |
| Canvas renderer up | 3,462 ms | 2,436 ms |
| **Pins drawn** | **6,236 ms** | **5,305 ms** |
| **LCP** | **3,240 ms** | **2,180 ms** |
| CLS | 0.001 ✅ | 0.012 ✅ |
| DOM nodes | 3,516 | 3,499 |
| Requests / JS errors | 113 / 0 | 107 / 0 |

API latency (three consecutive calls, box idle):
`/api/health` 4 ms · `/api/feed/live` 3–760 ms · `/api/pins/map` **1.4–6 s**.

**The one number that is a problem: 34.2 MB transferred on load.**
**27.6 MB of that is overlay probe grids fetched at boot even though the
overlays are OFF:**

| File | Size |
|---|---|
| `/data/lightning/grid_annual.bin` | **18.2 MB** |
| `/data/phytoplankton/annual.bin` | **4.1 MB** |
| `/data/wave/height.bin` + `period.bin` | **4.0 MB** |
| `/data/koppen/grid.png` | 1.0 MB |

That is a deliberate tradeoff — *"fetch at boot so the first toggle is
instant"* — but at **18 MB for one overlay** it costs every user on
every load, whether or not they have ever opened the lightning layer.
**Making those grids lazy drops page weight from 34.2 MB to ~6.6 MB**, a
5× reduction, for about a second on the first toggle. The basins and
languages layers already work this way (1.4 MB and 1.8 MB, fetched only
when switched on); the lightning grid is the outlier.

LCP is 3.24 s on desktop — inside Google's *Needs Improvement* band
(2.5–4 s) and over the *Good* threshold (< 2.5 s), because the same
34 MB competes with the map for bandwidth. Mobile clears *Good* at
2.18 s.

**Next wins, ranked:**
1. Make the heavy overlay grids lazy — 34.2 MB → ~6.6 MB, LCP follows
2. `/api/pins/map` 1.4–6 s — a viewport-scoped index or a precomputed
   pin set would cut it
3. `preconnect` to the tile and API origins to remove the handshake from
   the critical path

### Usability fixes (2026-10-29)

**The map was untappable on a phone.** The layers dropdown defaulted to
`collapsed: false` — a 365 × 2400 px panel on a 390 × 844 screen — so
**every tap landed on a layer row and no pin could be tapped**. Fixed:
`collapsed: isPhoneViewport()` (phones start collapsed, desktop stays
open), a `touchend` handler on the toggle (Chrome re-hit-tests the
synthesised click after the panel has re-laid-out, so it used to miss),
a `MutationObserver` that creates the ✕ on expand, and tap-outside to
close. See "Layers Dropdown — collapsed on phones" above.

**Accessibility:**

| Finding | Before | After |
|---|---|---|
| Controls with no accessible name | 2 (location input, search box) | **0** |
| Pin canvas ARIA | **none** — invisible to screen readers | `role="img"` + a label pointing at the keyboard-reachable Explore panel |
| Sub-44 px touch targets | **73** | **34** (the remainder are inline text links, exempt under WCAG 2.5.5's inline rule) |
| `lang` / `title` / map `tabindex` | ✅ already correct | ✅ |

The Leaflet zoom bar, world-view button, layers toggle and layers ✕ were
all 30 × 30 — below the WCAG 2.5.5 minimum. They are now **44 × 44 on
coarse pointers** (`@media (pointer: coarse)`), with Leaflet's compact
sizing kept on desktop. Same for the live-feed panel's toggle, location
field and buttons.

**Verified end-to-end on a real iPhone profile:** pins load and draw;
a tap on a pin's own canvas pixel opens *that* story (pixel-accurate
through the canvas buffer offset); the story tree renders; the mobile ✕
closes it; nothing overflows horizontally; the layers dropdown opens on
touch and closes via ✕ or tap-outside.

Pinned by `bun tests/test_mobile_pins.js` (21 assertions) and
`public_html/tests/frontend-hygiene.bun.test.js`.

## Key Files

### Worker Pipeline

| File | Purpose |
|------|---------|
| `worker/fetch.py` | Fetch 4,000+ RSS/JSON sources (5-min lease system) |
| `worker/web_scraper.py` | HTML scraping for `web`-type sources |
| `worker/extract.py` | AI content extraction (Gemma 4) |
| `worker/auto_categorize.py` | Fast-path city/category assignment + source-based fallback |
| `worker/place_disambiguation.py` | Ambiguous-name watchlist + source-country prior |
| `worker/geocode.py` | Turn place names → coordinates (Nominatim + caches) |
| `worker/density.py` | Detect/correct mislocated pin clusters |
| `worker/source_profiles.py` | Build `news_source_geography` profiles (**no timer — manual**) |
| `worker/cluster.py` | Group articles into events |
| `worker/validate_cities.py` | City coord vs country validation (Natural Earth) |
| `worker/health_monitor.py` | Detect & recover from crashes (`--cpu-guard` = load-pause writer, `*/2` cron) |
| `worker/pin_moderate.py` | Stage-2 deep moderation of community submissions (freq/URL/LLM) |
| `worker/timer_watchdog.py` | Restart dead timers / stuck services |
| `worker/isobars.py` | Pressure contours: fetch the GFS MSLP, contour it at 1 hPa (superset; the API thins to 2/4/8/16 via `step`), **merge → round → thin**, store the lines |
| `worker/tempmap.py` | Temperature field: fetch the GFS 2 m analysis, write the grid + ramp metadata |
| `worker/magmap.py` | Magnetic field (WMM2025): synthesize D/I/SV, contour isogonics + isoclinics (**no timer — static model**) |
| `worker/nn_infer.py` | Neural network inference pipeline (10min timeout) |
| `worker/nn_batch_links.py` | Batch generate AI story links |
| `worker/api_watchdog.py` | API liveness watchdog (*/2 cron) — restarts only on a liveness failure |
| `worker/fix_source_pileups.py` | Audit/reset the "one source owns one capital" pileups |
| `worker/normalize_location_countries.py` | `news_locations.country` → ISO-2 |
| `worker/repair_locations.py` | Relabel / merge duplicate location rows |
| `worker/daily_digest.py` | The daily digest: signals → selection → written artifact |
| `worker/digest_render.py` / `digest_upload.py` | Render the digest to video / upload it |

### Neural Network Models

Xyzo uses 6 active neural network models:

| Model | Purpose | Version |
|-------|---------|---------|
| `article_understanding` | Encode articles into embeddings | 0.20260909 |
| `event_matching` | Detect related events via cosine similarity | phase2_20260925_121935 |
| `relationship` | Classify event relationships (8 types) | phase5_20260925_160725 |
| `ranking` | Score article importance | phase3_20260925_142043 |
| `coverage` | Predict coverage gap scores | phase4_20260925_142108 |
| `category_classifier` | Classify article categories (72.5% val acc / 79.7% bucket) | v1 |

> ⚠️ **The accuracy figures that used to live in the table above (relationship 99.9%,
> ranking 100%, coverage 96.3%) were markdown-only claims.** The machine-readable source of
> truth, `nn_model_registry.metrics`, carried `{"note": "..."}` for 5 of 6 models — only
> `category_classifier` has ever had real measured metrics. Do not quote a model accuracy
> without checking the registry first.

> ⚠️ **Integration status (2026-09-26 audit, updated 2026-10-26):** 2 truly wired
> (`event_matching` → story links, `category_classifier` → category rescue), 3 decorative
> (`article_understanding`'s 16-dim vectors are a meaningless 768→16 truncation — the real
> semantic layer is the separate 384-dim MiniLM pipeline; `coverage` and `ranking` have no
> frontend consumer), 1 gone (`relationship` is consumed by `nn_batch_links`, which hardcodes
> the phase5 model path and breaks on the next retrain).

**Relationship Classes:** `same_story`, `related`, `follow_up`, `response`, `background`, `origin`, `destination`, `mentioned`

#### There is no geolocation model (removed 2026-10-26)

The `geolocation` neural head was deleted. It had **never placed a single article on the map**:

- Its predictions were written to `nn_prediction_cache` and read by **no** code anywhere —
  `predicted_lat`/`predicted_lng` appeared in exactly one file, the writer. It grew the table to
  12.8 M rows / 3.9 GB, refreshed every 5 minutes, for nothing.
- It **trained on zero text vectors**. `worker/nn_train.py:train_geolocation` skipped embedding
  precomputation ("using zero text embeddings for fast training"), and the phase-1 retrain
  constructed `GeoCrossCountryDataset(rows, …)` without ever passing `text_embs` — so
  `self.text_embs.get(eid, torch.zeros(…))` fed zeros to every sample. The text pathway learned
  nothing.
- Its "known bug validation" incremented its pass counter **unconditionally** — it reported
  20/20 passed for any model at all, feeding random noise, and `--validate` built a *fresh
  untrained* model to test.
- Its registered `final_loss: 0.0` was a **hardcoded literal**, not a measurement.
- Its live output was degenerate: 2,456 predictions in 24 h averaged **lat 10.25 / lng −114.28**
  (mid-Pacific), across only 79 distinct latitudes and 68 longitudes.

**Coordinates on the map come from the classical pipeline**, which places 95.5% of articles:
`auto_categorize` → `extract` (Gemma) → `geocode` → `place_disambiguation`. 100% of placements
over the last 24 h were `source_fallback` or `fast_path`; the NN only ever wrote a *category*
(`nn_word_freq`), never a location.

A guard test (`tests/test_nn_improvements.py::TestNoNeuralGeolocation`) now asserts the model
stays gone. **Do not reintroduce it without all three of:** (1) a real held-out evaluation with
measured precision/recall, (2) actual text embeddings in the training path, and (3) a write-back
path into `news_articles.extracted_lat/lng`.

### Neural Network Training

```bash
# Train ranking model
XYZO_DB_DSN="..." python3 -m worker.nn_phase3_ranking --train --deploy

# Train coverage model
XYZO_DB_DSN="..." python3 -m worker.nn_phase4_coverage --train --deploy

# Train relationship model
XYZO_DB_DSN="..." python3 -m worker.nn_phase5_relationship --train --deploy

# Generate AI-powered story links (runs every 15 min via timer)
XYZO_DB_DSN="..." python3 -m worker.nn_batch_links --run --hours 24 --limit 3000
```

> ⚠️ **No model has been retrained since 2026-09-25** and nothing schedules training — there is
> no cron, no systemd timer, no nightly step. Inference runs every 5 minutes; training never does.
> `worker/classification_learning_loop.py` (the only retrainer) is wired to nothing, and its 199
> stored user corrections still have placeholder article ids and `used_in_training = 0`.

### Systemd Timers

| Timer | Purpose | Scheduled | Reality (measured 2026-09-26) |
|-------|---------|-----------|-------------------------------|
| `xyzo-fast-fetcher.timer` | fetch → auto-categorize → geocode → cluster (no AI) | 5 min | one cycle takes 40–60 min; timer ticks are skipped while running → effectively ~1 sweep/h |
| `xyzo-fetcher.timer` | full pipeline incl. AI extract + learn + audio | 15 min | runs concurrently with fast-fetcher (double-polls ~1.5×) |
| `xyzo-nn-infer.timer` | NN inference + leaderboard refresh | 5 min | |
| `xyzo-nn-batch-links.timer` | Batch NN story-link generation | 15 min | |
| `xyzo-nlp-extract.timer` | claims/temporal/quantity NLP features | hourly | |
| `xyzo-story-link.timer` | story_linker 6 passes + PageRank | 6 h | last cycle ran 1h43m |
| `xyzo-trending.timer` | event_velocity + event stats + tfidf/pmi | hourly | keeps `news_event_velocity` fresh |
| `xyzo-retention.timer` | DB retention sweep (added Sep 26) | daily 04:30 | |
| `xyzo-queue-soak.timer` | ingestion queue soak monitor | daily 09:30 | |
| `xyzo-isobars.timer` | rebuild the pressure contours from the GFS analysis | 6 h | ~5 min per run at the 1 hPa interval (ECMWF 0.1° ~4 min, GFS 0.25° ~45 s); writes ~1,100 GFS + ~1,000 ECMWF isobar lines (each one a CONTINUOUS isobar — the merge runs before the rounding) |
| `xyzo-tempmap.timer` | rebuild the temperature colour field from the GFS analysis | 6 h | ~2 s per run; writes `data/temp/grid.bin` + `meta.json` |
| `xyzo-nightly.timer` | full sweep + trending-query discovery | 03:00 | |
| watchdog (root cron, 5 min) | `worker.timer_watchdog --fix` — restart dead timers + stuck services | 5 min | thresholds now realistic (fast-fetcher 90 min) |
| api watchdog (cron, 2 min) | `worker.api_watchdog --cron --restart` — restart a **hung** API | 2 min | restarts only on a liveness failure; a slow heavy COUNT is reported, never fatal |

> There is **no scheduled rebuild** of `news_source_geography` (source geographic profiles used by
> the source-based placement fallback) and no `xyzo-embeddings.timer` (384-dim MiniLM embeddings
> are refreshed inside other cycles). Run `python3 -m worker.source_profiles --all --days 30`
> manually after large placement corrections.

### Service Health & Watchdog

The watchdog (`python -m worker.timer_watchdog`) monitors both timer presence AND service runtime:

| Service | Max Runtime (configured) | Notes |
|---------|-------------|-------|
| `xyzo-fast-fetcher` | 90 min | Thresholds corrected 2026-09-26 (FIX_NOTES §9) — old 5-min value would have killed healthy 40–60 min cycles |
| `xyzo-fetcher` | 90 min | |
| `xyzo-nlp-extract` | 30 min | |
| `xyzo-nn-infer` | 15 min | Has built-in 10 min timeout (--timeout flag) |
| `xyzo-story-link` | 120 min | Last measured cycle: 1h43m |
| `xyzo-nn-batch-links` | 30 min | |

```bash
# Check status
python -m worker.timer_watchdog

# Auto-restart dead/hung services
python -m worker.timer_watchdog --fix
```

### API Watchdog (`worker/api_watchdog.py`, cron every 2 min)

**Only the liveness probes may condemn the API.** `/api/health` and
`/api/version` are the restart triggers; `/api/pins/stats` and
`/api/pins/map` are *measured and reported* but never fatal.

| Probe | May restart the API? | Budget |
|-------|----------------------|--------|
| `/api/health` | yes | 20 s |
| `/api/version` | yes | 20 s |
| `/api/pins/stats` | **no** | 30 s |
| `/api/pins/map` | **no** | 30 s |

A slow heavy COUNT is a **load** problem, not a hung process — and a restart
makes it worse: the unit validates the API in `ExecStartPre`, so Caddy answers
502 for the whole restart window. With the heavy probes marked as restart
triggers the API was bounced **every 2 minutes** (8 343 restarts logged) and
in-flight chat requests died with `Remote end closed connection`.

If a check ever condemns the API, look at `/api/health` and `/api/version`
first — not at the heavy queries.

### API Routes

| Route | Purpose |
|-------|---------|
| `GET /api/pins/map` | Fetch pins for map viewport |
| `GET /api/feed/live` | Live feed (Hot, Near, Your) |
| `GET /api/feed/links` | Story connection graph (Links UI — toggled from the layers dropdown) |
| `POST /api/explore-region` | Discover sources for region |
| `POST /api/add-source` | Manually add source |
| `GET /api/sources/health` | Source health dashboard |
| `POST /api/pins` | Community click-to-submit (two-stage moderation — see above) |
| `POST /api/news/submit` | Queue a user-pasted news URL for review (SSRF-guarded, pending-only) |
| `POST /api/news/:id/recommend` | Recommend an article (one vote/IP, integer counter) |
| `POST /api/ai/chat` | "Help Me" chat → hivv.org gateway (model-pinned, refusal-guarded, token-capped) |
| `GET /api/digest/today` | The day's curated digest (JSON artifact the video is rendered from) |
| `GET /api/weather/isobars` | Pressure contour lines (isobars) for a bbox — GFS MSLP |
| `GET /api/weather/isobars/meta` | Which GFS analysis the stored isobars came from |
| `POST /api/location-views` | Telemetry: what the user looked at (fractional zoom accepted) |
| `GET /api/image-proxy` | Proxied article images (404 for a dead host, not 400) |

> Full route map: `api/src/routes/` (~45 files — admin, audio, video, journalists,
> city-story, credibility, problems, science, search-intel …) and `api/src/routes/README.md`.

### Layers Dropdown

The top-right stack icon opens the **layers dropdown** — the single place
for map layers:

- **Base layers**: Street, Satellite, Topo, Streets, NatGeo, Terrain, Dark, Light
- **⛅ Pressure lines (isobars)**: the isobar checkbox, listed directly
  under the base layers (with its own opacity slider)
- **Overlays**, each with its own **opacity slider** wired to its name
  by dotted leaders (`name · · · · · slider%`; values remembered
  per layer in `localStorage` and carried in the shared link as
  `overlay=name@pct`):
  - NASA satellite / rain rate / earth at night
  - 🌍 Köppen Climate — 29-class key inside the dropdown
  - 🌡️ Temperature (GFS) — °C/°F legend + probe
  - 💨 Wind (GFS) — animated streamlines + probe
  - ⚡ Lightning density (WWLLN) — power-law colour ramp + probe
  - 🟫 Soil (SoilGrids) — WRB groups (default), USDA texture, clay,
    sand, silt, pH, organic carbon, bulk density, CEC — property chips
    inside the dropdown + probe
  - 🌾 Cropland (ESA) and 🗺️ Land Cover (ESA) — shared legend + probe
  - 💧 Rivers — Natural Earth, rank-styled GeoJSON
  - 🧭 Magnetic Field (WMM2025) — isogonics / isoclinics / isoporics,
    optional wash + probe, component switcher inside the dropdown
  - 🪨 Geology (Macrostrat) — colourful bedrock units + unit probe
  - 🗺️ Geologic contacts (USGS/GSC) — fault/contact line network
  - 🌍 Languages — Glottolog 8,889 points, probe lists every language at a point
  - 🛰️ Human Transportation — NOAA "Anthropocene" flights/shipping/roads
  - 🧂 Sea surface salinity — NOAA GFDL CM2.6 PSU wash, land transparent
  - 🤝 Facebook Friendships — ten million friendship arcs (NOAA SOS)
  - 🏙️ City names — population-filtered labels (reuses CityEngine's index)
  - ⛰️ Relief (ETOPO) — colour-shaded topography + bathymetry + probe (m/ft)
  - 🌊 Hydrological Basins
- **🔗 Story links**: the connection arcs between related stories

> A row injected into this dropdown must be a **sibling** of
> `.leaflet-control-layers-overlays`, never a child: Leaflet rebuilds that
> list on every layer change, so a row inside it is wiped by the first
> overlay toggle. The links row and the climate key are both siblings.
>
> The same applies to `.leaflet-control-layers-base` — Leaflet rebuilds
> the base list too, so the isobar checkbox is injected into
> `.leaflet-control-layers-list` (the parent) right after the base list.
>
> Every overlay object in `WEATHER_OVERLAYS` must provide `setOpacity`
> — `OverlayOpacity.mount()` calls it for each one, and a missing method
> used to abort `app.js` mid-boot (see *Overlay contracts* under
> Testing).

### Story Link Types

`GET /api/feed/links` returns the connections between the stories in the
current viewport. The edges are driven from the **articles in view**
(newest 1,200) with a `LATERAL` over the source/target indexes on
`news_story_links` — the old form scanned all 36.6 M link rows per
request (65 s), so the browser's fetch timed out and the arcs never
rendered. A viewport query is now **0.1–3 s**.

Link types:

| Type | Color | Source |
|------|-------|--------|
| `ai` | Green | NN relationship model (ai_detected) |
| `source` | Teal | same_event cluster |
| `location` | Amber | same_city / same_country |
| `topic` | Blue | same_topic |
| `entity` | Magenta | same_entity |
| `semantic` | Fuchsia | semantic_similarity |

### Frontend

| File | Purpose |
|------|---------|
| `public_html/app.js` | Main app (all logic, ~16.6k lines — canvas pin renderer merged in) |
| `public_html/index.html` | Entry point |
| `public_html/city-engine.js` | Client-side city gazetteer (lazy 3.9 MB dataset) |
| `public_html/console-guard.js` | Debug utilities (XLog + suppression, loads first) |
| `public_html/climate-layer.js` | Köppen-Geiger climate overlay (tiles + class key + probe readout) |
| `public_html/isobar-layer.js` | Isobar overlay (pressure contour lines from `/api/weather/isobars`) |
| `public_html/temp-layer.js` | Temperature overlay (colour field from `data/temp/grid.bin` + °F/°C legend + probe) |
| `public_html/wind-layer.js` | Wind streamline overlay (animated canvas from `data/wind/grid.bin` + probe) |
| `public_html/soil-layer.js` | Soil overlay (WRB groups + texture + 7 SoilGrids properties, property chips + probe) |
| `public_html/cropland-layer.js` | Cropland + land-cover overlays (two entries, one module, one probe grid) |
| `public_html/river-layer.js` | Natural Earth rivers (rank-styled GeoJSON in `riverPane`) |
| `public_html/geology-layer.js` | Macrostrat bedrock + USGS/GSC contacts (hotlinked tiles + probe) |
| `public_html/city-labels.js` | City-name labels on a canvas (population-filtered, reuses CityEngine) |
| `public_html/etopo-layer.js` | Topography/bathymetry relief (ETOPO 2022, hypsometric + hillshade + probe) |
| `public_html/wave-layer.js` | Wave height + derived power (NOAA GFS Wave grids, Height|Power switcher + probe) |
| `worker/wavemap.py` | Fetches GFS-wave GRIB into wave/*.bin; power formula + cycle no-op + verify gate |
| `public_html/overlay-opacity.js` | Per-overlay opacity sliders inside the layers dropdown |
| `public_html/digest-panel.js` | The "Today" digest panel on the map |
| `public_html/analytics.js` / `presence.js` | Batched telemetry with idempotency keys |
| `public_html/help-me-chat.js` | The floating 🆘 "Help Me" chat widget (persona, map/story context, refusal guard) |
| `public_html/help-me-chat.v5.js` | Same widget with SSE streaming (the API must answer `text/event-stream` for the streaming path to engage) |


> ℹ️ `public_html/viz.js` no longer exists — hexbin/pulse/constellation code was removed or merged into `app.js`. AGENTS.md session notes referencing it are historical.

---

## Debugging

### The AI Chat Misbehaves (refusals, slow answers, empty bubbles)

```bash
# 1. Does the API answer at all? (which model served it, how long)
curl -s -X POST http://localhost:3008/api/ai/chat -H 'Content-Type: application/json' \
  -d '{"system":"You are a direct assistant.","messages":[{"role":"user","content":"hi"}]}' \
  | python3 -m json.tool
#   → { "response": "...", "via": "primary", "latency_ms": 2143, "attempts": 1 }

# 2. Which bee answered? (the gateway's receipt header)
curl -s -D - -o /dev/null -X POST http://localhost:3011/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma-4-E2B","max_tokens":120,"messages":[{"role":"user","content":"hi"}]}' \
  | grep -i x-hivv-answered-by
#   → X-Hivv-Answered-By: localhost/gemma-4-E2B-it-Q4_K_M (direct)

# 3. The routing decision + model pin (gateway log)
grep "model pin" /var/www/vhosts/hivv.org/logs/out-25.log | tail -5

# 4. Is the gateway restarting the API every couple of minutes? (it used to)
tail -20 /var/www/vhosts/xyzo.org/logs/xyzo-api-watchdog.log
```

| Symptom | Usual cause |
|---------|-------------|
| `I'm sorry, but I can't assist with that.` | a small model refused; the API re-rolls, and the widget drops it — check `via`/`attempts` and which bee answered |
| Bubble stuck on "Thinking…" | the bee is slow or the box is saturated — check `latency_ms`; `XYZO_AI_MAX_TOKENS` keeps it bounded |
| `HTTP 502 ai_refused` | every model in the pool declined — rephrase the question |
| `HTTP 502 / 504` | the gateway or the fallback is down — check `:3011` and `:8888` |
| `Remote end closed connection` | the API was restarted mid-request — check the api-watchdog log (see above) |

### The Map Is Blank on the First Load

**Symptom:** the page loads, the panels render, but there is no map — the
container is 0 px tall. It usually fixes itself on a reload.

**Cause:** `index.html` loads `styles.css` asynchronously
(`media="print" onload="this.media='all'"`). If the stylesheet has not
landed when Leaflet initialises, Leaflet reads `position: static` and
forces `position: relative` **inline** — and the stylesheet's own
`#map { position: fixed; inset: 0 }` can never size the container
afterwards (a relatively positioned element with `inset: 0` is offset,
not sized). Reproduced in Firefox on a cold first load.

**Fix shipped:** `fixMapPositionIfLeafletClobbered()` re-checks after the
stylesheet lands (link `load` event + timed retries + `window.load`),
clears the inline override, re-measures the map, and falls back to an
inline `height: 100vh` so the map is never invisible.

**Still broken?** Check in the console:
`document.getElementById('map').getBoundingClientRect()` → if the height
is 0, the stylesheet never arrived (an extension may be blocking it) and
the `100vh` fallback should have kicked in — if it did not, the script
itself failed; look for an exception in `window.onerror`.

### A City Shows 100+ Stories That Are Not About That City

**Symptom:** one pin has an implausible count, and the stories behind it
are about something else entirely.

**Diagnosis:**

```bash
# what is under that pin?
psql "$XYZO_DB_DSN" -c "
  SELECT s.name, a.auto_categorize_method, COUNT(*)::int
  FROM news_articles a
  JOIN news_locations l ON l.id = a.location_id
  JOIN news_sources s ON s.id = a.source_id
  WHERE l.place_name = 'Bamako, ML'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10;"

# is one source behind it?
python3 -m worker.fix_source_pileups --dry-run
```

**Usual cause:** a source with the wrong `news_sources.country`, whose
unplaceable articles the source-based fallback pinned to that country's
capital. The gate in `_source_geo_is_country_specific()` prevents new
piles; `worker/fix_source_pileups.py` cleans up the old ones.

### Stories Land in the Wrong Country

**Check first:** is `news_locations.country` ISO-2? Full country names
("United States", "Türkiye") silently break every cross-country
comparison:

```bash
python3 -m worker.normalize_location_countries --dry-run
```

Then check the source metadata: `country = NULL` + a region means "this
source has no single country" (global platform, pan-regional wire);
`country = "ME"` with `region = MENA` is the Middle East, **not**
Montenegro.

### The API Keeps Restarting

```bash
tail -30 logs/xyzo-api-watchdog.log
journalctl -u xyzo-api --since "-1 hour" | grep listening
```

A restart is only correct when a **liveness** probe (`/api/health`,
`/api/version`) failed. If the log says `/api/pins/stats: Timeout after
8s`, the watchdog is misconfigured — a slow heavy COUNT is a load
problem, not a hung API. Also check that `validate-api.sh --quick` takes
about a second: if it takes a minute, every restart is an outage
(the unit runs it in `ExecStartPre`).

### Check if BigInt is the Problem

If you see `"JSON.stringify cannot serialize BigInt"` in logs:

```bash
# Test an endpoint directly
curl http://localhost:3008/api/your-endpoint | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), indent=2))"
```

If the JSON parses but the API still fails, the BigInt is in the response. Add `::float` casts to your SQL.

### Check Worker Status

```bash
systemctl status xyzo-fast-fetcher
journalctl -u xyzo-fast-fetcher -n 50
```

### Check Source Health

```bash
curl http://localhost:3008/api/sources/health | python3 -m json.tool
```

### View Recent Articles

```bash
psql "..." -c "SELECT title, published_at FROM news_articles ORDER BY published_at DESC LIMIT 10"
```

### Clear Stale Leases (After Crash)

```bash
XYZO_DB_DSN="..." python3 -c "from worker.fetch import cleanup_stale_leases; cleanup_stale_leases()"
```

---

## The Numbers

Measured from the live database on 2026-10-26:

```
Total database size:         68 GB     (84 GB on 10-24, 59 GB on 10-04)
Free disk:                  177 GB     (91% of 1.9 TB — was 92%)

Articles stored:          2,852,764   (~63k in the last 24 h; RSS+JSON+web+audio+video)
Articles on the map:      2,744,384   (extracted + located — 96.2%)
Articles awaiting place:      16,373   (pending — was 61,129 on 10-24)
News sources:                4,102     (172 countries)
Languages detected:           40+
Events clustered:            790,837   (bucketed, not similarity-clustered — see FIX_NOTES §1.9)
Locations (news_locations):   38,337   (ISO-2 country on every row)
Story links:              41,405,341   (24 GB with its indexes)
384-dim embeddings:        2,810,053   (the good semantic layer — HNSW indexed)
Audio shows / Videos:     *            not re-verified in this audit
```

> **The story-link graph is the largest table in the database and the fastest-growing thing
> on the box** — 1.7 M rows on 2026-09-26 → **41.4 M** now, ~10 M rows/week. 96% of it is less
> than 30 days old, so it is a *volume* problem, not an age problem. See "Database Storage
> Strategy" for why no age-based rule can fix it and what would.

---

## Database Storage Strategy

**Goal:** keep the total database around **20 GB**, while retaining the **top stories for 1–5
years**. Raw news is not worth storing — the durable record is the *event*, not every wire copy
of it.

> ⚠️ This section was rewritten on 2026-10-26. Two claims in the previous version were wrong and
> have been corrected below: **dropping `news_articles.body` is not safe** (see "Corrections"),
> and **`city_story_features` is not a one-time batch** — it is written and read continuously by
> the city-story subsystem.

### Measured state (2026-10-26)

```
Total database size: 68 GB   (was 84 GB on 2026-10-24, 59 GB on 2026-10-04)
Free disk:           177 GB of 1.9 TB  (91% — was 92%)

  news_story_links:          24 GB  39.8M rows   DERIVED
  city_story_features:       14 GB  29.2M rows   DERIVED
  news_articles:             12 GB   2.7M rows   RAW NEWS   ← only 18%
  nn_* + article_facts:     6.5 GB              DERIVED
  news_term_df:             3.3 GB   3.5M rows   DERIVED
  news_events:              1.5 GB 778.9k rows   THE HISTORY RECORD
  everything else:          6.7 GB
```

**The load-bearing fact: raw articles are only 18% of the database.** Deleting every article
would still leave 56 GB. Any policy that only prunes by article age cannot reach a 20 GB target
— it has to shrink the derived tables too. Those cascade off articles (`ON DELETE CASCADE`), so
article pruning *does* pull them down, but only ~4% of `news_story_links` is older than 30 days,
so a pure age rule barely dents it.

### What retention actually exists today

| Mechanism | What it prunes | Status |
|---|---|---|
| `xyzo-retention.timer` (daily 04:30) | `source_poll_observations` 90d, `news_fetch_decisions` 30d, `news_performance_metrics` 30d | ✅ works — ~1.6 GB total |
| `compute_tfidf` (hourly) | `news_term_df` older than 30d | ✅ works |
| `nn_infer` (every 5 min) | `nn_article_leaderboard_live` past `expires_at` | ✅ works |
| nightly Step 8 | `news_location_views` / `news_search_log` / `news_interactions` 30d | ⛔ **code exists, never runs** — the nightly job times out first |
| `nn_batch_links --cleanup` | `ai_detected` links older than 7d | ⚠️ **code exists, never scheduled** |
| **`news_articles` by age** | — | ❌ **nothing, anywhere** |
| **`news_story_links` by age** | — | ❌ **nothing, anywhere** |

There is **no size cap**: no PostgreSQL limit, no disk quota, no partitioning (0 partitioned
tables), no `autovacuum_*` overrides. `system-health-check.sh` *does* detect a >90% disk but its
only output is an `echo` into a log file — it is a log line, not an alert.

### Reclaimed 2026-10-26 — 22 GB

Run as part of the dead-NN cleanup:

| Action | Freed |
|---|---|
| Deleted 12.8 M geolocation rows from `nn_prediction_cache`, `VACUUM FULL` (6.2 GB → 554 MB) | 5.6 GB |
| `VACUUM FULL news_term_df` (12 GB → 322 MB, was 74% dead tuples) | 11.7 GB |
| `VACUUM FULL nn_training_features` (1.6 GB → 1.1 GB) | 0.5 GB |
| Dropped `news_articles_fts_idx` + `idx_news_articles_fts_extracted` (3.4 GB) | 3.4 GB |
| Dropped `news_articles_spatial_gist_idx`, `news_articles_fetched_only_idx` | 0.2 GB |
| Dropped `nn_article_leaderboard_live_vector_idx`, `REINDEX` the rest (703 MB → 496 kB) | 0.7 GB |

> **Why the FTS indexes were dead weight:** every search path in the API uses **trigram
> (`%`) / `ILIKE` / `similarity()`**, never `@@ to_tsquery`. Both GIN indexes had
> `idx_scan = 0` over the database's entire lifetime. Worse, their index expression includes
> `body`, so **every pipeline UPDATE re-indexed the full article text** — dropping them was a CPU
> win on the ingestion path as well as a disk win. The trigram indexes that *do* back search are
> kept (`idx_news_articles_title_trgm`, `idx_news_articles_summary_trgm`).
>
> **`DELETE` does not return space to the OS.** The reclamation above needed `VACUUM FULL`
> (table rewrite, exclusive lock) for each table. `pg_repack` is not installed. Without a
> rewrite step, deleting rows moves the disk figure by nothing.

**Finding found while doing this:** a `worker.run` process was stuck in uninterruptible sleep
(`D` state, 9 h 53 m, 5.4 GB RSS) holding a transaction **idle for 9 hours**. That pins the
PostgreSQL `xmin` horizon, which blocks autovacuum database-wide — it is a plausible root cause
of the accumulated bloat, not just a one-off. Terminated its backend with
`pg_terminate_backend` to unblock the maintenance.

### Corrections to the previous version of this section

**1. Do not drop `news_articles.body`.** The old text proposed `ALTER TABLE news_articles DROP
COLUMN body` for 2.4 GB. `body` is read by **ten-plus live workers**: `ner_extract`,
`journalist_resolver`, `relocate`, `story_mutations`, `knowledge_gap_detector`, `video_linker`,
`repin_suburbs`, `wikimedia_experiment`, `nn_features`, `links`. The two FTS indexes that used
it are now gone; the column is not.

**2. `city_story_features` is not a one-time batch.** The old text said "all from 2026-09-20,
can be truncated". It is **written** by `worker/city_story_intel.py` and **read** by six live
modules (`city_story_worker`, `city_story_rels`, `city_story_ml`, `city_story_update`,
`city_story_gemma`, `city_story_intel`). It has no `created_at` index, so it cannot be age-pruned
efficiently today.

**3. `rebuild_term_df` / `archive_city_features` / `storage_analysis` do not exist.** The old
"Regeneration Commands" block listed three modules that are **not on disk**. Do not copy them.

### Proposed retention policy — DESIGN ONLY, NOT IMPLEMENTED

Two measurements shape it:

**a) 60% of events are single-source.** That is the noise — local notices, one-off reports, sports
results.

| Event corroboration | Events | Share |
|---|---|---|
| ≥20 sources | 18,208 | 2.3% |
| 8–19 sources | 34,707 | 4.5% |
| 4–7 sources | 75,428 | 9.7% |
| 2–3 sources | 188,343 | 24.2% |
| **1 source** | **467,892** | **60.1%** |

**b) Top stories are the bulk, not the tail.** Events with ≥4 sources are only 16% of events but
hold **67% of all articles** (1,832,937), because a handful of mega-events absorb syndicated wire
copy:

```
articles per ≥4-source event:  median 6 · p75 12 · p90 27 · p99 154 · max 3,086
17,201 mega-events (>20 articles) hold 1,074,705 articles  ← 59% of "top" articles
```

So "keep the top stories for 5 years" **without a per-event cap keeps nearly everything**. The
cap is the whole design.

**Proposed tiers:**

| Tier | Definition | Keep |
|---|---|---|
| **T1 — history** | events with ≥4 independent sources, **capped at N articles each** | **5 years** |
| **T2 — recent** | events with 2–3 sources | **1 year** |
| **T3 — noise** | single-source events and unattached articles | **30–90 days** |

Derived tables should be pruned **to the retained article set** rather than by age — that is what
actually reaches 20 GB. (`news_events` is the durable history record and should be kept.)

**Three decisions still open — this is why nothing has been implemented:**

1. **Articles per top event** — cap at **5**, **10**, or **20**? (10 keeps 3–4 languages and
   several outlets without the 300-article pileup)
2. **Single-source retention** — **30 days** or **90 days**?
3. **Is 20 GB hard?** Achievable but tight; 25–30 GB is much safer.

**Build order when this is picked up again:**

1. `worker/retention.py` with `--dry-run` that models all three tiers and **prints projected
   per-table sizes before deleting a byte**. Reuse the id-keyed batched-CTE pattern from
   `scripts/retention_prune.py` (10 k rows/statement) so a CASCADE into a 24 GB table cannot
   hold locks for hours.
2. Add `created_at` indexes on `news_story_links` and `city_story_features` first — neither has
   one, so every future prune is a sequential scan.
3. Wire `nn_batch_links --cleanup` into a timer (the code exists; nothing invokes it).
4. Move the nightly's three broken 30-day `DELETE`s into their own oneshot timer, copying the
   `xyzo-retention` pattern, so they stop depending on a 4-hour job that always times out.
5. Add a real disk alert — `system-health-check.sh` already detects it and only logs.

### Index notes

**2026-10-23:** `news_story_links` carried three pairs of duplicate indexes
(`idx_story_links_source` ≡ `idx_news_story_links_src`, `idx_story_links_target` ≡
`idx_news_story_links_tgt`, `idx_story_links_city` ⊂ `idx_news_story_links_city_type`).
Dropping the duplicates freed 2 GB and halves the write amplification of every link insert.

**Still unindexed:** `news_story_links.created_at` and `city_story_features.created_at`. Both
are required before any age-based retention can run cheaply.

```bash
# find duplicate / unused indexes before dropping
psql "$XYZO_DB_DSN" -t -A -F' | ' -c "
  SELECT s.relname||' | '||s.indexrelname||' | '
         ||pg_size_pretty(pg_relation_size(s.indexrelid))||' | scans='||s.idx_scan
  FROM pg_stat_user_indexes s
  WHERE s.idx_scan = 0 AND pg_relation_size(s.indexrelid) > 20*1024*1024
  ORDER BY pg_relation_size(s.indexrelid) DESC;"
```

> Verify with `EXPLAIN` before dropping anything that *is* scanned: `idx_scan = 0` since the last
> stats reset is strong evidence but not proof, and a HNSW/GIN index can look dead because of the
> query shape rather than because the data is unused.

---

## The HOW TO tour (`public_html/tour.js`)

Owner ask (2026-11-04): *"we might want to build a 'how to' or a
'demo' of how all our features work when people first visit or ask for
help."*

A map with thirty-odd overlays, a live feed, a 3D globe, an export
dialog and a control menu cannot be explained in a paragraph, and
nobody reads a manual. The tour walks a reader through it in **six
steps**, each one pointing at the **real control it talks about**:

| Step | Points at | Says |
|---|---|---|
| 1 | — (the whole map, dimmed) | What the pins are, and that the overlays live around them |
| 2 | the layers dropdown | Every overlay the site has, each with its own opacity slider |
| 3 | the search bar | A place, a topic, or a question for the AI |
| 4 | the «Live status ›» button (the live panel starts closed) | The news as it happens, and the outlets that reported it |
| 5 | the 3D-globe button | The same map and the same pins, as a sphere |
| 6 | the ⚙ menu | Saved views, export, text size, the hover readout — and the tour again |

**Where it lives.** It is a **BUTTON**, and it is where a reader goes
when they want to be shown: ⚙ → TOOLS → *How to*, and the help panel →
*Show me how this works*. So **"ask for help" can be answered by SHOWING
rather than telling**.

**IT NO LONGER SHOWS ITSELF (owner, 2026-11-13).** It used to appear on
its own, once, on a first visit — 1.8 s after the boot. The owner:
*"dont show the 'how to' on the first load thats kinda annoying.. just
put that with something else"*. On a phone the card is a **sheet** that
covers most of the screen, so the reader's first sight of the site was a
modal card about a map they had not looked at yet — and a tour nobody
asked for is a tour that is closed unread. There is **no auto-start**
any more (`tour.js` has no `maybeAutoStart`), and the two buttons above
are the whole way in. `localStorage["xyzo.tourSeen"]` is still written
when the tour is closed, and `XYZO_TOUR.start()` still exists for
anything that wants to open it programmatically.

**The rules that make it a good guest** (each one pinned by a test):

- **THE SPOTLIGHT NEVER SWALLOWS A CLICK.** The cut-out is
  `pointer-events: none`, so the reader can press the very control the
  step is describing while the step is on screen. A tour that blocks
  the map teaches "you cannot touch this".
- **IT IS ALWAYS DISMISSIBLE.** Escape, the ✕, and Skip.
- **IT NEVER MOVES THE MAP.** The steps describe what is already on
  screen; flying the reader somewhere else would be a second thing
  happening at once.
- **IT IS A SHEET ON A PHONE.** Below 640 px the card docks to the
  bottom with the safe-area inset — a floating card on a 390 px screen
  covers the control it is describing.
- **THE CARD NEVER COVERS THE CONTROL IT DESCRIBES.** The placement
  is measured (the space right / left / below / above the target) and
  the audit asserts the two never overlap.
- **A SHARED LINK DOES NOT TRIGGER IT.** A reader who came in on a
  shared link was given a map by somebody and did not arrive to be
  shown the controls. (The decision used to be made on the hash **as it
  arrived** — captured at module level, because the default map is a
  preset and the preset becomes the URL, so reading `location.hash`
  later would mistake a first visit for a shared link. **There is no
  auto-start any more**, so the whole question is gone; the rule is
  kept as a statement of what the buttons do.)
- **ON A PHONE THE SHEET CLEARS THE BOTTOM BAR** — it is anchored to
  `--bottom-bar-top` (published by `publishChromeEdges()`), not to a
  typed constant. The bottom bar holds the **⚙ button**, and **step 6
  points at the ⚙ button**: a sheet that covered the bar would cover
  the very control the last step describes.
- **THE "🆘 HELP ME" PILL IS HIDDEN WHILE THE TOUR IS OPEN.** It is
  `position: fixed` on `<body>` at z-index 9998 — *above* the tour
  card — and it floated over a third of the card's text. It is an
  emergency affordance, not a control, and hiding it costs nothing.
- **A ZERO-SIZED ELEMENT IS NOT A TARGET.** A step's target may be a
  **list** of selectors, and the first one with a real size wins. Both
  control windows start closed now (2026-11-06), so the cases are: the
  layers toggle is 0 × 0 while its panel is **open**, and the live
  panel's own box sits off-screen at `translateX(-100%)` while it is
  **closed** — hence step 4 points at `#live-panel-reopen` first. The
  placement is **retried** for a beat, because the layers toggle is
  created by Leaflet and may not be laid out yet.

**Measuring it.** `scripts/tour_audit.py` drives a real browser: it
shows itself, every step has text, the spotlight lands on its target,
the card never covers it, Next/Back/Skip work, it does not come back,
the ⚙ menu replays it, a shared link does not trigger it, and it
survives a resize.

---

## The 🛰️ Default map, and the live feed's "AI Suggested" tab (2026-11-13)

Three owner reports, one session:

> *"can you have a easy way to 'clear the map to a default satellite only
> view' maybe down near [the ⚙ button]"* — then, with a map of their
> own: *"maybe this default map is wiser?"*
>
> *"also dont show the 'how to' on the first load thats kinda annoying..
> just put that with something else."*
>
> *"when the live feed pops up.. the Ai suggested isn't really showing
> correctly its all smooshed.. playwrite?"*

### The 🛰️ button — the satellite view, one click away

> *"for the 'clearned map' i think we just need a sattiltie view..
> https://xyzo.org/#19.9733,0.0000,2/density=max … its just too slow on
> some computers"* (owner, 2026-11-14)

The button sits in the **bottom bar, beside the ⚙**, and it restores
**the satellite view**:

```
#19.9733,0.0000,2/density=max
```

the world on the satellite basemap, the pin density at max, and **no
overlays at all**. It is the owner's own link to that view, verbatim.

**IT WAS THE OWNER'S OWN MAP, AND THAT WAS TOO SLOW.** From 2026-11-13
the button restored their heavier view — satellite, the **wind animation**
over the pressure lines:

```
#1.9771,36.1230,4/density=max/overlay=wind-gfs@100,isobars@100/iso=1:pressure/isoSrc=gfs/wind=particles:speed:100
```

and the owner's verdict on it was *"its just too slow on some
computers"*. The wind animation is the reason: **a canvas that repaints
every frame, over a field that has to be fetched and contoured first**,
is the most expensive thing on the page — and the button is the thing a
reader presses when they want the map to STOP doing that. So it went
back to what the first ask said it was — *"a default satellite only
view"*.

**IT IS A HASH, LIKE EVERY OTHER VIEW ON THIS SITE.** The default map
lives in `map-presets.js` as `DEFAULT_MAP`, is parsed by the same
`MapPresets.parseHash()` a preset and a shared link use, and is applied
through the same `applyMapState()` → `applySavedStyle()` →
`applyLayersFromParsedHash()` chain — so the button cannot produce a
map that a pasted link could not, and the removal half (the overlays
the reader happens to have on are dropped) is the same one. **A button
that assembled the map by hand would be a second implementation of "what
a map is", and the second implementation is the one that drifts.**

**THE HASH NAMES NO `overlay=` SEGMENT, AND THAT IS THE POINT.** The
hash-apply path only ADDS, but `applySavedStyle()` **REMOVES** every
overlay the state does not contain before it adds the ones it does — so
a hash with no overlays list is a hash that says **"none"**, and the
button CLEARS the map rather than adding to it. **A missing overlays
list must NOT be normalised into an empty array**: an empty array is
also what a CORRUPTED state (`{}`) would look like, and `sanitizeState()`
rejects that one precisely so it can never reach `applyMapState()` and
strip every overlay by accident.

**THE BASE LAYER IS STATED BY THE BUTTON, NOT BY THE HASH.** The hash
names no base layer, so `defaultMapState()` fills in `satellite`: a
reader who is on the street map and presses the button gets the default
**basemap** too.

**MEASURED LIVE** (`scripts/default_map_check.py`, Playwright against the
live site, a real browser and a real device profile, measured after the
network has gone quiet — the overlay grids are fetched lazily, so a
fixed wait measures a page mid-flight):

| | overlays | requests | bytes |
|---|---|---|---|
| the showcase (a capable machine's first visit) | **13** | 250 | 4.7 MB |
| **the satellite view (a slow machine's first visit)** | **0** | **130** | **2.6 MB** |
| after the 🛰️ button on the showcase | **0** | — | — |

**HALF THE REQUESTS, ABOUT HALF THE BYTES** — and the button's own
result: **0 overlays**, base **🛰️ Satellite**, zoom **2**, centre
**(19.9733, 0)**, and the URL `#19.9733,0.0000,2/density=max` — the
owner's link, exactly.

**THE BAR HAS NO ROOM ON A PHONE — MEASURED, AND THE ⚙ IS THE LAST
ITEM IN IT.** On a 393 px phone the language switcher takes **157 px**
and each button is **44 px** (the WCAG floor), so the bar's content is
**397 px in a 377 px bar**: the ⚙ hangs **29 px off the right edge**,
and with it the whole control menu (the density, the hover mode, the
text size, the export, "How to"). The bar button is therefore **hidden
below 560 px**, and the same action is in the **⚙ menu → MAP → "🛰️
Default map"**, which is one tap away on every device. **A button that
pushes the ⚙ off the screen has cost more than it gives.**
`scripts/live_panel_audit.py` now checks that **every** bottom-bar
button is on screen and can be tapped, on a desktop and on a phone.

### The LOW-RESOLUTION tier — the satellite view too (2026-11-14)

> *"we also have some checks to see before loading the page if we should
> show a low rez version without any overlays except the satellite view
> correct.. thats already workin but we might need to test it"*

**THE CHECKS WERE WORKING. THE "LOW REZ" MAP THEY CHOSE WAS NOT.** The
tier (`MapPresets.deviceTier()` — no save-data, no 2G/3G, ≥ 4 cores,
≥ 4 GB if reported, a phone-sized screen demoted unless it admits
≥ 8 GB) decided correctly; but the map it selected for a slow machine
was the **"🌱 Climate skin"** — the Köppen wash plus the city names — and
**the city names alone pull the 1.16 MB city index**. So the light map
was not light, and the owner's description of what it should be was
*"without any overlays except the satellite view"*.

**`COOL_ID.low` IS `"plain"` NOW** — a new **satellite-only** preset,
`#19.9733,0.0000,2/density=medium`:

| | the showcase (`high`) | the satellite view (`low`) |
|---|---|---|
| overlays | **13** | **0** |
| base | satellite | satellite |
| pins | max (3,000) | **medium (1,500)** |
| first load | 250 requests · 4.7 MB | **130 requests · 2.6 MB** |

**THE PIN DENSITY IS MEDIUM, NOT MAX**, and that is the one field that
differs from the 🛰️ button's hash: the pins are the heaviest thing a
slow machine fetches, and the density is a **separate axis** from the
overlays — the two views are the same MAP with a different number of
pins on it. The "🌱 Climate skin" is still a chip in the ✨ Cool maps
row, so nothing is taken away from a reader who wants it.

**THE TIER IS NOW MEASURED, NOT ASSUMED** —
`scripts/default_map_check.py` stubs a slow machine's `deviceMemory`,
`hardwareConcurrency` and `connection.saveData` before the page's
scripts run, and asserts that the first visit opens **with no overlays
at all**, that a capable machine still gets the showcase, and that the
🛰️ button clears the map. Tests:
`public_html/tests/map-presets.bun.test.js` (the tier, the light map and
the global-view rule) and `public_html/tests/default-map-button.bun.test.js`
(the hash, the base and the "no overlays" contract).


### The "AI Suggested" tab — squeezed, and it never loaded

**TWO DEFECTS WERE BEHIND ONE SENTENCE, and only a browser could see
either of them.**

**1. THE TAB STRIP WAS SQUEEZED.** Five tabs in a 320 px panel, one
flex row: each tab got **~58 px**, so **"🤖 AI Suggested" broke into
FOUR lines**, every other label into two, and the strip **overflowed the
panel by 14 px** — the last tab was cut off at the panel's edge
(measured: 300 px of content in a 285.8 px box). The strip is a **GRID**
now: two columns, and the longest label takes the whole last row. Every
label is on **one line** at the default text size, and nothing overflows.
Below ~330 px, and at the **largest text size (A++**, where the header's
content box is 290/1.3 = 223 px and a half-column no longer fits a
label), the grid falls back to one column.

**2. THE TAB NEVER LOADED.** It asked the pins **list** endpoint for
`min_confidence=0.85` with **no time window** — and that query's
articles leg has no time predicate, so the plan was a **sequential scan
of the 17 GB `news_articles` table** behind a window function.
**MEASURED on the live site: the query was still running after THIRTEEN
MINUTES** (four copies of it, each reading 17 GB), and the tab said
**"Loading AI Suggestions…"** for the whole of that time. The same
endpoint with a window answers in **0.94 s** (24 h) and **3.4 s** (3 d).

**SO THE TAB IS WINDOWED, ALWAYS** — the panel's own time filter,
capped at **three days**, and "all time" capped too. **THE ARITHMETIC IS
THE POINT**: a window is `[since, now]`, so a **shorter** window has the
**later** start, and the answer is the **later** of the reader's `since`
and the cap (`max`, not `min`). Taking the earlier one — the first
version — made the cap **widen** the window: the default 24 h filter
asked for three days. It now asks the **map** endpoint
(`/api/pins/map?bbox=-180,-85,180,85&limit=60&since=…`), the site's own
hot path, which also carries the **place, the country and the image** —
so a card says *where* the story is. **MEASURED: 1.7–3.4 s cold** on
this box (0.2 s warm), against an unbounded query that never answered.

**TWO MORE HONESTY FIXES IN THE SAME TAB.** The confidence badge was
`confidence_score || 0.9` — so a story the server had said **nothing**
about was shown as **"🤖 90 % Match"**, a number the server never sent;
the badge is now drawn only when there is a confidence to draw. And the
failure path fell back to the feed's **hot** list — **a different
answer under the same tab name**, which the reader cannot see; a failed
list now says so, with a retry.

**Measuring it.** `scripts/live_panel_audit.py` drives the **shipped
page** on a **desktop**, a **phone** (393×852, real touch) and at the
**largest text size**, and asserts: the tour does not open itself, ⚙ →
TOOLS → "How to" still opens it, every tab label is on one line, the
strip does not overflow, every bottom-bar button is on screen and
tappable, the AI tab shows cards that say where they are, and the 🛰️
button puts the owner's map on the screen (the satellite base layer, the
wind, the pressure lines, and a URL that says the same map).

Tests: **`public_html/tests/default-map-button.bun.test.js` (11)**,
**`public_html/tests/live-panel-tabs.bun.test.js` (11)**,
**`public_html/tests/tour.bun.test.js` (20, rewritten for the opt-in
contract)**.

---

## The NASA tile proxy (`api/src/routes/tileProxy.ts`)

The three NASA GIBS overlays — the rain rate, the true-colour
satellite, the night lights — are the only layers that come from
another server **live**, and they had two faults.

**1. A 404 ON A TILE IS A CONSOLE ERROR.** GIBS publishes a tile only
where the product has a value, and answers **HTTP 404** for the rest
(the open ocean, the poles). A 404 on a tile is a 404 on an `<img>`,
and **the browser logs it** — no JavaScript can suppress a message the
network layer produced. So the tiles come through our own route, which
applies the same rule the image proxy already uses: **a missing tile
answers HTTP 200 with a 1×1 transparent PNG.**

**2. "YESTERDAY" IS NOT "THE MOST RECENT PUBLISHED PRODUCT".** GIBS
publishes the true-colour satellite a day or two behind, so the client
asking for `nasaDate(1)` got a whole layer of 404s — the checkbox said
"on" and the map drew **nothing**. The proxy now **probes**: it asks
GIBS for a canary tile (a fixed one over central Africa, which every
one of these products covers) and walks the date back until one
answers, then serves the whole layer from that date. One consistent
picture, not a seam of three days. The night lights are pinned to
2016-01-01 and are served as asked — "the most recent published" is
meaningless for a historical product.

**The rules of the route:**

- **THE URL IS BUILT SERVER-SIDE, NEVER TAKEN FROM THE CALLER.** The
  dataset, the date, the zoom and the tile numbers are path segments
  and the upstream URL is assembled from a **whitelist**, so the route
  has **no SSRF surface at all** — there is no `?url=` to abuse.
- **THE EXTENSION IS PER DATASET.** The true colour is JPEG; the rain
  and the night lights are PNG. Asking for the wrong one is a 404.
- **THE ZOOM RANGE IS ENFORCED.** GIBS answers **400** for a level its
  matrix does not have ("Level6 supports zoom 0..6"), and a 400 is a
  console error too — so the proxy refuses it first.
- **A 404 IS RETRIED BEFORE IT IS BELIEVED.** GIBS sits behind a CDN
  with more than one origin and the same URL answered **404, 200, 200,
  404** across four identical requests. Without the retry a tile that
  *does* exist is served blank, and the date probe walks back a day
  for no reason.
- **THE PROBE IS SHARED.** A screenful of tiles arrives together, so
  the canary is asked once per dataset per hour, not once per tile.
- **TILES ARE CACHED** for an hour — a tile for a given date never
  changes, so the second reader of the same view costs nothing.
- **A MALFORMED REQUEST IS A 400** — that is about the request, and
  the reader can act on it. Only a *missing tile* becomes a
  placeholder.

Measured over three fresh loads of the default map: **no 4xx and no
console errors at all**, where before there were two to five GIBS 404s
per load.

---

## Search — the region a query frames (2026-11-09)

Owner report: *"when i search for 'artificial intelligence' it find some
articles but zooms in to an area that doesnt have any stories.. cant we
quickly calculate that 'region' and zoom out to the best area?"* — with the
URL ending at `#49.7961,9.8988,10` (Würzburg, zoom 10), and a second run at
`#34.1618,-33.3984,2` (the middle of the South Atlantic).

### The two causes, both measured against the live API

**1. THE "PLACE" WAS A BUILDING.**

```
GET /api/geocode?q=artificial+intelligence
→ { lat: 49.7960534, lng: 9.8987993,
    display_name: "Center for Artificial Intelligence and Robotics, 2,
                   Franz-Horn-Straße, Zellerau, Würzburg, Bayern, 97082,
                   Deutschland",
    place_type: "university",
    boundingbox: ["49.7960034", "49.7961034", "9.8987493", "9.8988493"] }

GET /api/locations/search?q=artificial+intelligence&limit=5
→ { place_name: "Artificial Intelligence", event_count: 3,
    lat: 49.7960534, lng: 9.8987993 }
```

An **eleven metre** bounding box, and a location row named **exactly** like
the query. The old gate was *name equality* — "the query IS a place" — so it
passed, and the map flew to the door and zoomed to 10. The same is true of:

| Query | The geocoder's answer | Its box |
|---|---|---|
| `artificial intelligence` | the Center for Artificial Intelligence and Robotics, Würzburg | **11 m** |
| `climate` | the Climate Pledge Arena, Seattle | **150 m** |
| `nvidia` | the Nvidia headquarters | **~100 m** |

**2. THE REGION WAS THE BOUNDING BOX OF A WORLDWIDE SET.** The stories for
"artificial intelligence" are in San Mateo, Kyiv, Quito, Perth and Paris.
Their box has its centre in the **South Atlantic, some 2,300 km from the
nearest story** — which is the "empty area" the reader saw. A box that wide
is not a region; it is the world.

### The rules now in force (`frameSearchRegion()`, in `app.js`)

- **A place may only frame the map when it is a REGION.** A box narrower
  than `MIN_REGION_DEG` (**0.05° ≈ 5.5 km**) is a point of interest — a
  building, a campus, a stadium — and is rejected. A rejected anchor is
  also kept out of the status line: naming the building in the status is
  naming the thing we just refused to zoom to.
- **Otherwise the region comes from the RESULTS** — the raw story
  locations, never the renderer's spread positions (a spread position is a
  lie about where a story happened; the exporter keeps `_rawPins` for the
  same reason).
- **A result set that spans the world is framed by the WORLD VIEW**
  (`WORLD_SPAN_DEG` = 90°), because the box of a worldwide set has its
  centre in an empty ocean.
- **A real place still wins.** "el salvador" → the country
  (13.70, -88.91 z9), "tokyo" → the city (35.69, 139.69 z7), "japan" →
  Japan fitted (see below). The strict *name equality* gate, the
  box-centre agreement and the point-of-interest rule are unchanged; the
  extent cap moved from `< 25° × 40°` to **`< 60° × 100°`** on 2026-11-11,
  because the old one rejected the boxes of most big countries — see
  below.

### ONE implementation

`runSearch()` and `runTextSearch()` each carried their own copy of the
gate, and they had already drifted: one read `geoMatchesQuery`, the other
`geoStrong`; one read `event_count`, the other `events_count`. Both now
call `frameSearchRegion()`. `fitToResults()` and `collectAllLatLngs()` are
gone with it.

### The map moves QUICKLY

The event search spawns a Python worker and can take **30–90 s** (measured:
6 s warm, 90 s cold), and it used to be awaited together with the rest —
so the reader watched the old view for a minute and a half and *then* the
map jumped. It is now **started before the framing and awaited after it**,
so it overlaps the framing instead of delaying it. Measured on the live
site: the map moves at **4.2 s** instead of **14 s**.

The pins query is the other half of the wait and is **not** fixed — see
Q-N28.

### A short query matches a WHOLE WORD (2026-11-09)

Owner report: *"the strories dont seem to be related mostly becuase the
ltters ai show up not ARTIFICIAL INTELLLEGENCE"*.

`GET /api/pins?q=ai` matched `ILIKE '%ai%'` — so **said**, **rain**,
**air**, **detail**, **campaign** and **again** all counted. Measured on
the corpus (2.99 M articles):

| | titles |
|---|---|
| contain the letters "ai" somewhere | **558,168** |
| contain the WORD "ai" | **59,100** |
| → the noise | **499,582** |

**The rule** (`api/src/lib/wordmatch.ts`, ONE implementation shared with
the event search — which already matched whole words, so the same query
could answer with two different sets of stories):

- a term of **≤ 3 characters** matches a whole word (`\m…\M`);
- a longer term keeps the substring match, because **"coronavirus" must
  still find "coronaviruses"**, which a word boundary would miss.

**THE PHRASE BRANCH WAS THE LAST HOLE.** "ai" has expansion terms
("artificial intelligence", "machine learning", "neural network",
"deep learning") so it took the multi-term path — whose phrase match was
still a bare substring, and that phrase is what drowned the expansions.
The phrase now takes the same rule as a term.

**AFTER: all 1,000 results for "ai" carry "AI" / "artificial
intelligence" / "machine learning"; zero noise.** The query also got
**faster** — 3.8 s against 22–50 s for the long-term path.

**The cost:** the dotted spelling of an acronym (**"A.I."**) is **578
titles** and is not matched by `\m…\M` — 1 % of the AI corpus.

### A location row must be corroborated by the geocoder

`/api/locations/search?q=ai` answers with a junk row named **"AI" on
Long Island, New York (353 events)**; `/api/geocode?q=ai` answers with
**ANGUILLA**. The two are **2,700 km apart**, the name-equality gate
passed, and the map flew to a place called "AI" at zoom 6.

**The two are independent oracles, and a row whose name happens to equal
the query is only a place if the geocoder agrees on WHERE it is**
(`ANCHOR_AGREE_DEG` = 6°). A row that matched the name and was not
corroborated is dropped from the map **and** from the status line, and
its stories are not fetched at all.

**No geocode answer means nothing to contradict the row**, so the row
stands — that is the "Anguilla" case, where both agree.

**The name comparison folds the accents**: a reader types "wurzburg" or
"sao paulo", not "Würzburg" and "São Paulo".

### The chip bar must not offer a word that names nothing

The extractor's prompt showed the model `"topic_tags": ["3-6", "short",
"topic", "tags"]` — a placeholder — and **many models copied it
verbatim**. Those four words are literal tags on thousands of articles:

| tag | articles |
|---|---|
| "3-6" | 2,741 |
| "short" | 1,482 |
| "tags" | 1,395 |
| "topic" | 1,265 |

The chip bar offered a chip labelled **"topic"**, and a reader who
clicked it got a map of articles about nothing in particular — which is
exactly what it looks like. Three fixes, because the data already holds
the rows:

- the **prompt** shows an empty list and asks for the tags in prose;
- the **extractor** strips the four words before writing them, and falls
  back to the article's event type;
- **`/api/tags/top` filters them**, so the rows already in the table
  cannot reach the chips.

### The saved answer (stale-while-revalidate)

A text search is the slowest thing on the site — the pin query ranks
with `ts_rank_cd` over the whole corpus and measures **3–50 s** cold, and
the event search spawns a Python worker for another **30–90 s**. So a
repeat search must not make the reader wait for an answer they have
already seen.

**The memory answer, because it decides the design:**

| | |
|---|---|
| the **query** | a few dozen bytes — **free** |
| the **results** | **1.5 MB** for 1,000 pins (1,620 B a pin) |
| …of which `word_freq` | **711 KB (45 %)** — and the popup fetches its keywords on demand from `/api/pins/:id/words` |
| the **slimmed** copy | **773 KB** a search |

So the browser keeps the answers in **IndexedDB — DISK, not RAM**,
capped at the **12 most recent** searches (≈ **9 MB of disk**), and
nothing is added to the tab's memory beyond what the live search already
puts there. The **server** keeps a copy too, and that one *is* RAM — so
the search cache is now **byte-budgeted** (64 MB ≈ 40 full answers)
instead of being limited by entry count, which cannot express a memory
limit anyway (200 × 1.5 MB was a **300 MB ceiling** on the API process).

**What the reader sees** (measured on the live site, API cache cold):

```
t= 0.23s  Showing saved results from 11/9/2026 · searching for newer…
t= 1.80s  359 matches · 30 new events · updated ✓
```

**The framing is NOT saved as a decision.** A saved answer is framed by
the **same function** that frames a live search (`frameSearchRegion`), so
a saved search can never put the map somewhere a fresh one would not.

**The trap, found by measuring:** the first key carried the `since`
**timestamp**, and `getSinceDate()` snaps to a 60-second boundary — so
the key changed every minute and the saved answer was never found
again. The key carries the time **window** (`24h`, `all`, `custom:7`)
instead.

### A search for a COUNTRY must not land on a CITY (2026-11-11)

Owner report: *"when we search for something it zooms into the wrong
area… i just searched for 'china' and it zooms into
`#12.6283,-87.1326,9` … it also says **No news found near Chinandega,
Chinandega Department, NI** … this is a generalized problem"* — and then
*"a search for 'india' zooms into indianapolis this is wrong as well"*.

**ONE DEFECT: `detectCitySearch()` PREFIX-MATCHES, and in every case the
query is a prefix of a bigger city's name.** Measured against the
shipped index (`public_html/data/cities.10k.json`), the whole matrix:

| Query | The city it flew to |
|---|---|
| `china` | **Chinandega, Nicaragua** (pop 126k) |
| `india` | **Indianapolis, Indiana** (pop 887k) |
| `peru` | **Perugia, Italy** (pop 161k) |
| `florida` | **Florida, CUBA** (pop 63k) |
| `maine` | **Maine Township, Illinois** (pop 140k) |
| `korea` | **Koreatown, California** (pop 124k) |
| `virginia` | **Virginia, SOUTH AFRICA** (pop 122k) |

The city branch then fetched pins **by bbox, not by query** and framed
the city — hence "No news found near Chinandega" for a search about
China.

**NO STRUCTURAL RULE CAN FIX IT.** "china" → Chinandega and "chica" →
Chicago are both mid-word prefixes of a city name, and prefix matching
must keep working while the reader types ("new" → New York City, "kansas
c" → Kansas City, "san" → San Francisco Bay Area). The difference
between the two queries is that one of them **names a country** — so the
gazetteer carries the list, exactly the argument the US state table
already makes for two-letter abbreviations.

**THE FIX, THREE PARTS:**

1. **`BIG_PLACE_NAMES` in `city-engine.js`** — the ISO 3166 English
   country names plus the forms people actually type ("usa", "ivory
   coast", "burma", "holland", "côte d'ivoire"), normalised with one
   `normPlace()` on both sides, plus the 51 US **state names** derived
   from `US_STATES` (one table, not two). `detectCitySearch()` returns
   `null` for an exact match on the list, so the query falls through to
   the two oracles that answer for a country: `/api/geocode` and
   `/api/pins?q=`. All three city-path call sites (`runSearch`,
   `runTextSearch`, the search-mode pin fetch) go through that one
   function, so the guard covers them all.
2. **THE GEOCODER ANSWERS IN THE LOCAL SCRIPT**, so the name gate would
   still reject the country even after the city path steps aside —
   measured live (2026-11-11): `china` → **中国**, `japan` → **日本**,
   `korea` → **대한민국**, `brazil` → **Brasil**, `turkey` → **Türkiye**,
   `peru` → **Perú**. Not one of those display names starts with or
   equals the query. `frameSearchRegion()` therefore accepts a
   geocoder answer that is BOTH an **administrative** area (a country or
   a state — Nominatim answering `turkey` with Turkey, **Texas** is a
   town and still loses) AND for a query **on the list** ("climate" and
   "artificial intelligence" never reach the clause, so the
   point-of-interest and corroboration rules are untouched). The list
   arrives as a **parameter** (`isBiggerPlace`), keeping the framing
   function a pure function of its arguments — which is what lets the
   tests run it against a stub map with no `window`.
3. **THE EXTENT CAP WAS TOO TIGHT FOR COUNTRIES.** The old `25° × 40°`
   rejected China (44.9° × 61.3°), India (29.1° × 29.5°), Brazil
   (39.1° × 45.4°), Canada (41.7° × 88.7°) and Australia (46.2° × 96°),
   so a country search fell back to a point at zoom 6 and showed a
   slice of it. The cap is now **`60° × 100°`** — every country whose
   box is honest fits — while still rejecting what must be rejected: the
   **United States' box is 86° × 360°** (it includes Wake and Guam),
   **Russia's crosses the antimeridian at 360°**, and a continent or the
   world is wider still; fitting THOSE would zoom out to the whole
   planet, which is the failure the cap exists for. Note the cap never
   was what protected against Tokyo's prefecture (15.7° × 18.4° passes
   any sane cap) — the box-centre agreement is, and that is unchanged.

**VERIFIED LIVE (Playwright, `scripts/search_place_check.py` + the
`?q=` boot path):**

```
china  -> 33.99,104.14 z4   "133 matches · 30 new events · China · 191 stories"
india  -> 21.85, 82.66 z5   "238 matches · 30 new events · India · 310 stories"
peru   ->-10.28,-76.64 z5
florida-> 27.75,-83.80 z7
washington -> 38.89,-77.01 z10   (the city, via the loc row — unchanged)
unchanged: el salvador 13.70,-88.91 z9 · tokyo 35.69,139.69 z7 ("All news
in Tokyo, Tokyo, JP · 28 stories") · chicago 41.85,-87.65 z7 ·
climate change -> world view
```

**0 page errors.** The status line now names the COUNTRY it went to —
"No news found near Chinandega" is gone with the branch that said it.

### A search took 24–75 SECONDS (2026-11-11)

Owner ask: *"lets check that various searches are working and also fast..
we want to preindex the top 1000 or so searches so that theya re all very
fast… in the background we can always update the REAL LIVE data we just
want fast results to start with"*.

**THE MEASUREMENT FIRST.** The same endpoint, the same day, before and
after a cache miss:

| Query | cache hit | cache miss |
|---|---|---|
| `tokyo` | 0.22 s | **34.6 s** |
| `india` | 0.23 s | **26.6 s** |
| `israel` | 0.24 s | **37.9 s** |
| `london` | 0.22 s | **24.4 s** |

A search answer is ~1.2 MB of JSON and the server's RAM cache holds
**64 MB** — about 40 answers — so every search evicted the others and
the next reader paid the full price again.

**THREE CAUSES, THREE FIXES.**

**(1) THE FUZZY BRANCH MADE THE WHOLE OR UN-INDEXABLE.** The text
predicate is an OR of five legs; four are served by the trigram GIN
indexes, and the fifth —
`source_kind = 'web_discovered' AND discovery_query ILIKE '%q%'` — is
not served by anything. One un-indexable leg inside an OR is enough: the
planner gave up on the index and fell back to a **parallel seq scan of
the whole 3.8 M-row table** (759,156 rows discarded by the filter),
reading **397,043 buffers — 3.1 GB of I/O** — to produce 978 rows.
**And that leg is worth almost nothing: `source_kind = 'web_discovered'`
is 20 ROWS in the entire corpus.** A partial GIN trigram index over
exactly those twenty rows
(`2026-11-11-search-text-indexes.sql`) makes the leg indexable, and the
planner ORs all five.

**(2) THE FUZZY RULE WAS THE WRONG SHAPE.** The branch was
`title % t AND similarity(title, t) > 0.3` — a **whole-string**
similarity, so a 5-letter word can only reach 0.3 against a *short*
title, and the index scan for it started from the query's three trigrams
(which match a sixth of the corpus): **1,149,700 index tuples and
584,762 heap rechecks for 1,584 rows, 25,463 ms.** Word similarity
(`title %> t`, `pg_trgm.word_similarity_threshold = 0.6`) compares the
query against a **word** in the title: **102 ms, 1,005 rows**. It is
also the better rule — it finds *"Chinese companies bag contracts…"* for
**china** and *"Japanese President"* for **japan**, which the substring
rule misses entirely ("chinese" does not contain "china"). Measured over
the real query mix the switch **loses 0–3 rows per query and gains 33
(tokyo) … 10,961 (china, every one of them about China)**; the rows it
loses are junk — for "tokyo" they were two articles titled *"Tok tok
tok"*.

**(3) THE STATEMENT WAS PLANNED GENERICALLY.** The statement text is
the same for every search — only the parameter values differ — so after
five executions Postgres switches it to a **generic plan**, which cannot
know the parameter is a selective trigram and picks the seq scan again.
The same statement measured **718 ms under a custom plan and 37,679 ms
under the generic one**. The search now runs with
`plan_cache_mode = force_custom_plan`.

**(4) THE LOCATION COUNT READ THE WHOLE ARTICLE TABLE.**
`/api/locations/search` — called on **every** search — counted the
articles of **all 45,231 locations** before it could answer a query
about a handful of places, because the aggregate was uncorrelated:
**2,050 ms**. Counting only the *matched* locations, with
`(location_id, published_at) WHERE status = 'extracted'` making each
count an index-only scan: **67.7 ms**.

**AND THE ENTITY BRANCH.** A known company carries an implicit location
("nvidia" → Santa Clara), matched with
`a.extracted_location ILIKE '%santa clara%'` — a free-text field on
3.59 M rows, so it was the second un-indexable leg: **155,931 ms**. The
city is now resolved to its `news_locations` row first (45 k rows, a
trigram index, a millisecond) and the article side became
`location_id = ANY(...)`. Measured on "santa clara": 35,291 articles
match the text form and **35,231** match the id form — the 58 that
differ never became a location row.

**AFTER, on the live site:**

| Query | Before | After |
|---|---|---|
| `tokyo` | 34.6 s | **0.94 s** |
| `india` | 26.6 s | **1.3 s** |
| `volcano` | 39.3 s | **0.58 s** |
| `nvidia` | 155.9 s | **1.78 s** |
| `artificial intelligence` | 48.4 s | **2.5 s** |
| `/api/locations/search` | 2.05 s | **0.33 s** |

### The Pre-Index Answered Only One Shape of the Question (2026-11-12)

The pre-index stores the answers to the most-searched queries, and a
background job keeps them current. Two things stopped it from answering
most readers.

**THE LIMIT WAS PART OF THE KEY.** The key is
`query | window | tag | limit`, and the builder stored **1,000** — so a
reader who asked for **100** or **250** pins of the same query missed
and ran the live search. Measured: **1.07 s** for 250 pins of a query
whose answer was already on disk.

**A SMALLER LIMIT IS NOW SERVED BY SLICING A BIGGER STORED ANSWER.**
The stored answer is the **ranked list**, and the ranking does not
depend on the limit — so the first N of a 1,000-pin answer is exactly
what the live query would have answered for N. Only the pagination has
to be recomputed (`has_more`, and the cursor, which points at the last
row that was kept). A limit **bigger** than anything stored cannot be
sliced, and falls through to the live query.

**THE "ALL TIME" WINDOW WAS NEVER BUILT.** The builder's window list is
`["24h", "all"]`, but the timer passed `--window 24h`, which restricted
it to one — and "all" is the expensive one (the ranking runs over the
whole corpus), so it is the window that most needs a stored answer. The
timer now builds **both**.

Measured after, on the live site:

| request | before | after |
|---|---|---|
| `limit=1000`, 24 h | 0.26 s (preindex) | 0.26 s (preindex) |
| `limit=250`, 24 h | 1.07 s (live) | **0.21 s (preindex)** |
| `limit=100`, 24 h | 0.31 s (live) | **0.19 s (preindex)** |
| `limit=1000`, all time | live query | **0.23 s (preindex)** |

Tests: `api/tests/pins-search-preindex.test.ts` (8).

## The Zoom Is the Reader's Choice, Not the Map's (2026-11-13)

Owner ask: *"rather then autozooming in on a pin thats in a city we need
to give people the option after the popup opens to zoom in someplace in
the popup after they click on the news pin."*

**WHAT IT WAS.** Clicking a pin called `maybeZoomToCluster()`, which
flew the map to a city-level view of the pin's neighbours — unasked. The
reader's view of the world was taken away from them by a pin they had
merely tapped, and the popup opened into the middle of that 700 ms
flight (which is why the popup had to wait for the map to settle at all).

**WHAT IT IS NOW.**

- **A PIN CLICK DOES NOT MOVE THE MAP.** The popup opens where the
  reader already is.
- **THE POPUP CARRIES THE ZOOM.** A **🔎 "Zoom the map to this place"**
  button in the action row, beside the coordinates and the satellite
  button.
- **THE BUTTON ALWAYS DOES SOMETHING.** With three or more stories
  nearby it shows the cluster — the view the auto-zoom used to give
  unasked — and with an isolated pin it shows the place itself at city
  level (`Math.max(map.getZoom(), 11)`, so it never zooms **out**). A
  button that does nothing is worse than no button.
- **THE BUTTON IS IN THE ACTION ROW, NOT BELOW THE FOLD.** The popup's
  content is ~914 px in a ~380 px box, so a control lower down the
  popup is invisible **and** un-hittable: clipped content is not
  hit-tested.
- **THE OVERFLOW BADGE STILL FLIES TO ITS CLUSTER.** It is a cluster
  badge ("43 stories here"), not a story pin — a different gesture.
- **THE POPUP STILL WAITS FOR THE MAP TO SETTLE.** The small pan to the
  pin is still an animation, and a popup that opens into it slides for
  the rest of it, and the ✕ Close moves with it.

Measured live (Idaho, zoom 9): click a pin → **zoom 9 → 9** (the map
did not move) → click 🔎 → **zoom 9 → 11** ✓.

Tests: `public_html/tests/popup-zoom-to-place.bun.test.js` (6).

## The Owner Caught a Regression I Introduced (2026-11-12, later the same day)

The owner pasted a live failure — a screenshot of the page and the
diagnostics panel:

```
📡 Connection hiccup
cached 1h ago — Brief network issue — showing cached data. Will retry automatically.

{ "when": "2026-11-13T06:13:03.214Z", "kind": "exception",
  "errorName": "Error", "errorMessage": "Set map center and zoom first.",
  "bbox": null, "url": null,
  "userAgent": "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0" }
```

**THE CAUSE WAS THIS SESSION'S OWN CHANGE** — the "the initial view is
the link's view" fix, an hour earlier.

**LEAFLET 1.9.4 HAS NO `setView`/`center`/`zoom` CONSTRUCTOR OPTION.**
The vendored file has zero hits for `options.setView`; Leaflet's Map
takes its view from `map.setView(...)` and nothing else. So the option
was **silently ignored** — the map was created with **no view at all** —
and every accessor threw:

```js
_checkIfLoaded: function () {
    if (!this._loaded) throw new Error("Set map center and zoom first.");
}
```

The **first pin fetch** asks the map for its bounds, so it died, and the
reader got *"Connection hiccup — showing cached data"* instead of
markers. It showed on **Firefox** because Chromium's timing hid the
window in which the map had no view.

**A SECOND BUG OF MINE COMPOUNDED IT.** The boot view was built as an
**array** (`[lat, lng, zoom]`) and read with **`.lat`** — which is
`undefined` on an array — so the map was told
`setView([undefined, undefined], undefined)` and answered *"Invalid
LatLng object"*. That exception killed **the rest of app.js** — including
the fix that gives the map container its height on Firefox — so the
container stayed 0 px tall and the map was invisible.

**THE LESSON IS THE PART WORTH KEEPING: THE FIRST VERSION OF THE TEST
PASSED AGAINST THE BROKEN CODE.** It asserted the *source shape*, and
the shape matched — the code read exactly as intended, and did exactly
the wrong thing.

> **A GATE THAT PASSES AGAINST BROKEN CODE IS NOT A GATE.** A
> source-shape assertion can only catch a mistake you thought of. The
> behavioural gate catches the ones you did not.

**THE GATE IS NOW BEHAVIOURAL**: `scripts/first_load_audit.py` drives
the shipped page in **Firefox AND Chromium** and asserts

* no page errors (an exception in the boot kills the rest of app.js);
* the map **has a view** (`getZoom()` works);
* the **markers arrive**;
* the container **has a height** (the Firefox first-load race leaves it
  at 0 px);
* the link's **overlays are on**;
* and the **stale-data notice is NOT showing** — a reader who gets a
  failure notice where a map belongs has been failed.

It runs against the owner's own fifteen-overlay link, because that is
the case that broke. **Firefox is in it because the failure only showed
there.**

**AND THE NOTICE NOW TELLS THE TRUTH.** An exception is a bug in the
page, not a network problem: it says **"Map problem — the map hit an
error while loading"**, not *"Connection hiccup — brief network issue —
will retry automatically"*, which sent the reader looking for a problem
on their side and promised a retry that could not possibly help.

Tests: `public_html/tests/first-load-speed.bun.test.js` (12, mutation-
checked against the array bug) and `scripts/first_load_audit.py` (both
browsers).

## The Markers Were Waiting for the Browser to Decode 280 Tile Images (2026-11-12)

Owner report: *"markers seem to be taking a long time to load... in fact
it took more then a few min when my friend tried to load"* — and then,
after the first fix: *"seems to take about 30 to 45 seconds... are you
sure.???"*

**THE FIRST MEASUREMENT WAS WRONG, AND THE OWNER WAS RIGHT.** It said
"6.8 s". It was wrong three ways: it measured the **first** markers
rather than the finished page, it ran on **this box over the loopback**
rather than on a reader's network, and it sampled the resource timing
while the heavy responses were **still in flight** (the browser only
records a resource once it has finished).

**THE TRUTH, MEASURED PROPERLY** — the same fifteen-overlay URL, on a
throttled slow-3G link (1.6 Mbps, 300 ms):

```
t = 10.6 s   the pins ARRIVE
t = 30.5 s   the markers are PAINTED      ← a twenty-second gap
```

**THE NETWORK WAS NOT THE CAUSE.** The main thread was busy decoding
and painting the **280 tile images** of the eight raster overlays the
link asked for (35 tiles a layer, 8 layers), and the pin canvas drew
after all of them. The reader looked at an empty map for twenty seconds
because a URL had fifteen overlays on it.

### The three fixes, and what each was worth

**① THE INITIAL VIEW IS THE LINK'S VIEW.** The map was created at the
world view (z2) and **moved** to the hash's view a moment later, so the
browser asked for the **16 world tiles, threw them away**, and only then
asked for the real ones — while they competed with app.js for a slow
connection's bandwidth. The hash is now parsed **before the map
exists** and the view goes in as the constructor's own view.

**② THE CITY INDEX IS NOT ON THE CRITICAL PATH.** A
`<link rel="preload">` in the HEAD does **not** wait for idle — the
browser starts it as soon as it parses the HTML. The 1.16 MB city index
was the **first request on the page (t=0.30 s, before app.js)** and it
stole the bandwidth app.js was waiting for, and the markers cannot start
until app.js lands. The preload is gone, and the index is fetched when
it is needed: when the reader touches the **search box** or the **map**
(the city search path and the popup's nearest-town lookup are what need
it).

> The "idle" warm inside city-engine.js had the same trap in a milder
> form: `requestIdleCallback` fires as soon as the browser has *any*
> idle time, which during a map boot is the moment it is **waiting for
> app.js**. So "idle" was not idle at all.

**③ THE OVERLAYS ARE STAGED.** The basemap and the **markers** come
first; the overlays are added a frame later — which is what every map
does anyway (the overlays fill in over the basemap). The total time to
"everything" is the same; the time to a **usable map** is twenty
seconds shorter. The overlay **names** are recorded immediately, so the
URL the reader ends up with still lists every overlay they asked for.

### Measured after

| link | markers painted | (before) |
|---|---|---|
| loopback (this box) | **2.9 s** | 11.5 s |
| 4G — 5 Mbps, 100 ms | **4.2 s** | 9.0 s |
| slow 3G — 1.6 Mbps, 300 ms | **12.4 s** | **30.5 s** |
| slow 3G, a FIRST VISIT (the "cool map" preset) | **11.2 s** | ~25 s |

The first visit is staged too: the curated preset names thirteen
overlays, and it reaches the map through the same
`applyLayersFromParsedHash`, so the markers come first there as well.

### A STAGED QUEUE IS ONLY AS GOOD AS ITS DRAIN — and this one had one (2026-11-20)

**Staging moves the overlays into a queue. Something has to empty it,
and the queue had exactly ONE drain: the `items.length > 0` branch of
`fetchPinsForViewport`.** Every other exit from that function threw the
queued overlays away:

- the **25 s auto-abort** firing while the NDJSON body was still streaming;
- an **HTTP 5xx**, a **network error**, an **exception**;
- an **EMPTY result** — a sparse area is a normal, successful answer;
- a fetch **superseded** by a newer one (the stale `inflightCtrl` guard);
- the **markers-off / content-layers-off early returns**, which never
  reach the `try` block — and therefore never reach its `finally`.

So a shared link naming nine overlays drew the basemap and **nothing
else**, until some later fetch happened to succeed with pins — which is
why the owner reported having to pan around to get them:

> *"not all the tiles will load but if you wait like 2 min or 3 min
> finally the last tiles will all turn blue… you maybe even have to pan
> around the map"*

**Measured on his own URL, Chromium over throttled Regular 3G:
`/api/pins/map` answered 200, and 215 s later the overlay tiles had
still never been requested** — 28 basemap tiles, 0 overlay tiles.

**THE RULE: the queue is drained by the one path every outcome shares,
not by the outcome you hope for.**

- **`finally` on `fetchPinsForViewport`** drains it — success, empty,
  error, abort and exception all fall through there. The drain goes
  through `scheduleDeferredOverlayFlush()`, which is idempotent, so the
  success branch and `finally` can both call it and neither can queue a
  second frame chain.
- **The two early returns drain themselves**, because they never reach
  the `try`.
- **`armOverlayFlushBackstop()` drains it if no pin fetch ever runs** —
  a boot path nobody has foreseen. It *waits for* a legitimate flush
  (a queued one, or one from a fetch in flight) rather than racing it.

**AND THE BACKSTOP'S CEILING IS TIED TO THE FETCH'S OWN ABORT — this is
the trap.** An earlier version used a 20 s ceiling against a **25 s**
fetch abort, so on exactly the slow connection the bug was found on the
safety net would have fired *first* and released the overlays **ahead**
of the markers — reintroducing, through the net meant to replace it, the
very ordering the staging exists to prevent. Every fetch is guaranteed
to settle within 25 s (the abort still runs the `finally`), so the
ceiling is **30 s**: long enough that the normal path always wins, short
enough that a reader is never left staring at a basemap.

**Measured after:** flush at 18.5 s under the same throttle, **290**
overlay tile requests (was 0), and the three deterministic failures
(`/api/pins/map` **delayed 60 s / 500 / aborted**) went **0 → 290**
each. **The markers still come first:** pins rendered → overlays
released **+114 ms** unthrottled, **+72 ms** throttled — two frames,
unchanged.

Tests: `public_html/tests/deferred-overlays.bun.test.js` (**15**,
mutation-checked — 11 of 15 fail against the pre-fix `app.js`).

**The instrument for this is `scripts/tile_tail_audit.py`**, which
attributes every tile request to the layer that asked for it and fails
when a layer the link named drew nothing:

```bash
python3 scripts/tile_tail_audit.py                      # the owner's link, ~40 s
python3 scripts/tile_tail_audit.py --throttle "Regular 3G" --wait 180
python3 scripts/tile_tail_audit.py --json reports/tile_tail.json --shot /tmp/t.png
```

It reads the **CDP Network domain**, not Resource Timing — Resource
Timing only lists a resource once it is DONE, so a tile still in flight
when the run ends is invisible there, and "invisible" is exactly how
this bug looked. It also separates the wind layer's `<canvas>` tiles
from `<img>` tiles, because a canvas has no `complete` property and a
probe that ignores that reports 28 permanently-pending tiles on a
perfectly healthy page. Exit code 1 when a layer is missing or a tile is
still in flight.

**AND THE PAGE IS STILL THE SAME SIZE.** 425 requests, ~4 MB, 296 of
them raster tiles — the request count barely moved, because the tiles are
the point of the page. What moved is **when the reader can see the
map**. The remaining 25–30 s to "everything" is those 296 tile
requests, and that is the next lever (a coarser pyramid, or a
server-side composite of the layers that share a viewport).

Tests: `public_html/tests/first-load-speed.bun.test.js` (9).

## The Markers Were Slow Because the Box Was (2026-11-12)

Owner report: *"markers seem to be taking a long time to load.. in fact
it took more then a few min when my friend tried to load"* — a
fifteen-overlay URL over Idaho.

**THE MAP WAS NEVER THE PROBLEM.** The same URL measures **250 requests,
4 MB, 75 pins, settled inside 15 seconds**. The marker fetch itself is
`/api/pins/map?bbox=…`, and it measured **1.27 s cold and 0.19 s warm**
on a quiet box.

**THE BOX WAS THE PROBLEM.** It ran at **load average 23**, and the
heaviest thing on it was this session's own **pre-index builder**:
every entry it builds is one full search query (the ranking runs over
the whole corpus), so a thousand of them back-to-back is a thousand
seconds of **database time** — and the reader's marker fetch is the same
database.

**THE FIX IS A MANNER, NOT A SPEEDUP.** The builder now pauses **two
seconds between entries** and builds **at most 60 entries per pass**;
the timer asks for a slice, so the whole list still refreshes without
starving the site while it does. A background job that shares a database
with the reader is a **guest** in someone else's house.

**THE OTHER HALF OF THAT LOAD WAS NOT OURS.** `worker.nn_batch_links
--limit 3000 --min-score 0` runs at **60 % CPU** on its own, with
`nn_infer` beside it — the pipeline's own jobs, and the reason the box
was at 23 before this session's builder started.

## The Related Stories Are Links (2026-11-12)

Owner ask: *"when someone checked for 'related stories' we need to be
able to click on them and immediately go to the website that is linked or
related."*

The tree API has carried each article's **`url`** — the publisher's own
page — all along (`story-tree.ts`: `url: pin.canonical_url || null`).
The popup rendered the headline as **plain text**, and the click on the
row **flew the map** instead. So the link was there, and was not used.

Now:

- **the headline is a link** (`target="_blank`, `rel="noopener
  noreferrer"`, URL escaped ✓) — the reader goes to the story and the
  map stays where it was;
- **the ◎ button** beside it is the move on the map — so clicking a row
  with no coordinates still does something sensible rather than nothing;
- a click on the link is **not** also a camera move.

**Measured live:** 45 related stories, every one a real publisher URL.

Tests: `public_html/tests/popup-related-stories.bun.test.js` (5).

## The CHANGE MAP — the pressure of ONE analysis, and the CHANGE in it (2026-11-12)

Owner ask: *"it would be nice if we could show a 'secular' version of the
pressure maps.. so you click on a 'delta' and you can select to see the
'change in the last 24 hours map and kinda show a new isometric pressure
map with lines of change.. 1 moon cycle meaning 29.(moon phase).. 1/4 (per
season) a year 1/2 a year 1/3 1/6 a year or 1/8 a year 2/3 a year or one
full year"* — and *"we still want to support 0.10 hPa 0.25 0.5 1 2 4 8 16
hPa for all the new maps as well"*.

**THE FORMAL NAME.** The difference between two pressure analyses is an
**anomaly**; the change over a period is the **pressure tendency**, and
the map of it is a **Δp chart** — what a forecaster reads to see where
the air has RISEN and where it has FALLEN.

**WHERE IT LIVES.** The isobar layer's legend now carries a **CHANGE**
row under the detail switch:

| chip | window |
|---|---|
| **pressure** | the ordinary chart — the pressure of ONE analysis |
| **24 h** | the change over the last day |
| **3 d** | three days |
| **7 d** | a week |
| **moon** | one lunar cycle (29.53 days) |
| **season** | a quarter of the year (91.3 days) |
| **year** | a full year (365.25 days) |

The two rows are the two questions about this layer: **how fine the
lines are**, and **over what period**.

**THE ARCHIVE HOLDS THE FIELD, NOT THE LINES.** A difference of two
sets of contour lines is not a field — you cannot subtract a polyline.
So `worker/pressure_delta.py` archives the **1° pressure field** of every
cycle (130 KB a cycle, **190 MB a year**) and the API differences two of
them on demand, for any window and any past cycle. Storing the delta per
window would cost **1.5 GB a year** for a field that is 190 MB.

**THE CLIENT CONTOURS IT**, which is what makes the whole ladder work:
`public_html/delta-contour.js` cuts the grid at the chosen step, so
**0.10, 0.25, 0.5, 1, 2, 4, 8 and 16 hPa all work from ONE fetch** —
and the server never contours a delta at all, so there is exactly one
contouring implementation for the change maps and nothing to drift. The
grid is at **0.05 hPa per unit — the GCD of the ladder** (the same rule
the isobar worker follows: 0.25 is *not* a multiple of 0.1, so a 0.1 hPa
grid could not hold a 0.25 hPa level at all).

### THE FIELD IS FETCHED ONCE, NOT ONCE PER PAN (2026-11-14)

**THE DELTA FIELD IS THE WHOLE WORLD, AND IT DOES NOT CHANGE WITH THE
VIEWPORT — only the CONTOURING does.** The first version fetched it
again on every pan, and it also left `state.loaded` null, so
`loadedCovers()` could never short-circuit and the delta path was the
only one that always ran.

**MEASURED ON THE LIVE SITE: four pans of the change map cost FOUR extra
fetches of the 130 KB field** (five field fetches for one map). The
field, its grid, its metadata and the colour scale are now **cached
against the window they belong to**, and the box the lines were cut for
is recorded — so a pan **re-contours from the cache** (the cheap part)
instead of going back to the network for the expensive part.

**AFTER: ONE field fetch for the whole session**, and the pans still
redraw — the lines went **395 → 364** as the viewport moved, with the
fetch count unchanged. The contouring is the same code on the same
field, so the picture is the same.

Pinned by `public_html/tests/isobar-delta-url.bun.test.js` and measured
by `scripts/isobar_delta_url_check.py` (which pans the map and asserts
the fetch count does not move).

### THE WINDOW IS IN THE URL — `delta=24h` (2026-11-14)

Owner ask: *"can you make sure the url is updated when someone clicks on
`<button … data-delta="24h">24 h</button>`"*.

**THE WINDOW LIVED ONLY IN localStorage** (`xyzo.isobarDelta`). The chip
changed the map, the address bar did not move, and the **share button
copies `location.href` VERBATIM** — so a reader who switched to the change
map and pressed Share handed over a link to the **ordinary chart**. The
same defect the detail step (`iso=`), the line colour (`iso=…:red`) and
the analysis (`isoSrc=`) had.

**THE SEGMENT IS `delta=<window>`** — `24h` · `3d` · `7d` · `moon` ·
`season` · `year`:

```
#2.5480,40.4297,3/overlay=isobars@100/iso=0.1:pressure/isoSrc=gfs/delta=24h
```

| rule | why |
|---|---|
| written **only when a window is chosen** | the ordinary chart is the default and there is exactly ONE way to spell it, so a segment that says "the default" can only add a way to be wrong. This is the **one** isobar segment that is *not* written always — the step has eight values, and the reader's own stored one would decide otherwise |
| applied **before the layer is enabled** | the window decides WHAT the fetch asks for (`/api/weather/pressure/delta?window=…` instead of `/api/weather/isobars`), so it has to be on the layer when the layer goes on — ONE fetch, carrying the right window |
| a link is a **VIEW** (`persist: false`) | opening someone else's map must not overwrite the reader's own stored window |
| only the windows the layer **OFFERS** are accepted | a hand-edited link must not be able to ask the archive for a window that does not exist |
| the chip row is repainted from `setDeltaWindow()` **itself** | a window can arrive with no click at all (a link, a saved style), and a chip row that says "pressure" while the map draws the change map is a control lying about what is on screen |
| the URL moves **before the archive answers** | the reader pressed a chip; the address bar should say so at once, not after the fetch |

**THE SAME GRAMMAR IN ALL THREE READERS** — `app.js` (the URL),
`map-presets.js` (a preset and the auto-saved last-used map) and the
saved style ("MY STYLE → Save this view", which is a snapshot of the
EXACT map). One segment, one meaning: a preset, a pasted link and a
saved style can never diverge.

**A PASTED LINK IS A SAME-DOCUMENT NAVIGATION** — the page does not
reload, so the boot-time restore never runs and the `hashchange` handler
is the only thing that can apply the link. It enabled the isobar layer
but never its settings, so pasting `/iso=0.25:red/delta=24h` into an
open tab promised a picture the map was not drawing. **It now applies
all four** — the step, the colour, the analysis and the window — in the
same order the boot path uses.

**MEASURED LIVE** (`scripts/isobar_delta_url_check.py`, Playwright against
the live site): the click moves the URL to
`#2.6358,40.4297,3/overlay=isobars@100/iso=0.1:pressure/isoSrc=auto/delta=24h`;
switching back to "pressure" **drops** the segment; a **cold** link opens
on the change map (`source === "delta"`) with the chip active while the
reader's own stored window ("7d") **survives**; and a link **pasted into
an open tab** applies it too. **0 page errors.**

Tests: `public_html/tests/isobar-delta-url.bun.test.js` (15).

### THE CHANGE MAP USED TO FREEZE THE COMPUTER (2026-11-13)

Owner report: *"lets see what we can do to speed up the 'delta pressure'
maps.. they do load however they freeze up the computer and almost crash
it.. rather then trying it out by clicking on it first make sure it loads
fast without selecting that setting because it will most likely crash the
system. try the other 'delta' modes too and speed the load times up in
general... we might need to rethink the entire way we display isometric
pressure delta maps and isometric pressure in general"*.

**THREE DEFECTS, ALL MEASURED ON THE REAL 24-HOUR DELTA** (the
2026-11-12 → 2026-11-13 analysis, on the 1° field the archive holds):

**1. THE LEVELS RAN FROM -180 TO +180 hPa** — the **longitude** range,
applied to a chart about a *change* in pressure, which lives around zero.
For the 0.10 hPa step that is **3,601 levels** where the field spans ~840,
and every one of them is a full pass over the 65,160 cells: **234
million cell tests**. **5,771 ms** to draw a chart whose levels run from
−40 to +44 hPa.

**2. THE FIELD WAS NEVER BLURRED.** The **live** chart is contoured from
a Gaussian-blurred field (`worker/isobars.py::smooth_field` — σ = 2
cells, wrapping in longitude, nearest at the poles) precisely because
the analysis carries structure below synoptic scale and contoured raw it
breaks into thousands of fragments. The change map skipped that, so it
contoured the GRIB's own noise — and **a difference of two fields is
TWICE the noise**. The blur cuts the 0.10 hPa chart from **28,171 lines
to 12,024** and gives the change map the same character as the live one.

**3. THE WHOLE WORLD WAS CONTOURED AND THEN TRIMMED TO THE VIEWPORT** —
so every pan paid for the whole globe. The client already holds the whole
field (130 KB), so it can contour only the cells the reader can see.

**BEFORE → AFTER** (the shipped code, the real field, best of three runs):

| step | view | before | after |
|---|---|---|---|
| 0.10 hPa | the whole world | 4,247 ms · 28,171 lines · 916,632 points | **1,572 ms · 12,024 lines · 583,362 points** |
| 0.10 hPa | a continent | 5,372 ms · 28,171 lines | **41 ms · 1,013 lines** |
| 0.10 hPa | a country | 3,933 ms · 28,171 lines | **4 ms · 828 lines** |
| 0.10 hPa | a city | 4,154 ms · 28,171 lines | **0 ms · 12 lines** |
| 1 hPa | the whole world | 429 ms · 2,848 lines | **180 ms · 1,212 lines** |
| 4 hPa | the whole world | 115 ms · 765 lines | **39 ms · 344 lines** |

**AT EVERY ZOOM IN FROM THE WORLD THE CHANGE MAP GOES FROM SECONDS TO
MILLISECONDS** — and at the world view it is 2.7× faster and draws half
the lines.

**MEASURED IN THE BROWSER** (the metric that matters: the **long task**,
the main-thread block that freezes the tab — `scripts/delta_chart_check.py`):

| | before | after |
|---|---|---|
| 24 h @ 0.10 hPa | ~6 s of blocking | **976 ms** |
| 24 h @ 1 hPa | ~6 s | **170 ms** |
| 3 d @ 1 hPa | ~6 s | **232 ms** |
| 7 d @ 1 hPa | ~6 s | **152 ms** |

**THE ORDINARY PRESSURE CHART WAS NEVER THE PROBLEM**
(`scripts/isobar_speed_check.py`, measured the same way): 0.10 hPa → 463 ms
of long tasks, 0.25 hPa → 169 ms, 1 hPa → **0 ms**.

**THE REWRITE WAS PROVED TO BE THE SAME ALGORITHM.** The hot loop was
rewritten (it allocated ten arrays a cell), and the proof is a comparison
against the previous implementation over a whole synthetic field: the two
produce **byte-identical lines at every level**. It also **fixed a latent
bug** — the last column's neighbour was read from the *next row* instead
of the grid's first column, so the seam was contoured against a wrong
value.

**THE CHANGE MAP GETS ITS OWN RAMP** — blue where the pressure fell, red
where it rose, pale in the middle — because the pressure ramp
(940–1060 hPa) means nothing on a map of differences. The scale is the
largest |change| on the **whole** map, so a line does not change colour
as you pan. The labels are **signed and carry their unit**: "+8 hPa" says
the pressure rose, "−3 hPa" says it fell.

**THE WINDOWS LIGHT UP AS THE ARCHIVE FILLS.** The worker backfilled
the ten days NOMADS keeps, so **24 h, 3 d and 7 d work today**; the
lunar cycle, the season and the year are **greyed out, with the reason**
("the archive has to reach back that far"), because a year-long change
cannot be computed until a year of fields exists. The route says the
same thing in as many words rather than answering with an empty map.

Tests: `api/tests/weather-delta.test.ts` (3),
`public_html/tests/delta-contour.bun.test.js` (8).

## The TIME MACHINE — a year of the weather maps (2026-11-12)

Owner ask: *"can we also save the 'maps' wind maps and temperature for 1
year.. so for example people can type in the date and see what it looks
like for the past year.. maybe also keep the time too.. if it takes less
then a few gigabyets its maybe worth it.. pressure wind temp and maybe
news for that day? why not?"*

**THE THREE WEATHER WORKERS REPLACE THE PREVIOUS CYCLE WHEN THE NEXT
ONE LANDS.** The wind grid, the temperature grid and the pressure
contours are each published from scratch every analysis, so the past was
not a lookup — it was gone. `worker/weather_archive.py` copies every
cycle into `data/weather_archive/<cycle>/`, and the API serves it.

**THE SIZE, MEASURED (the question that decides the design):**

| Field | 1° (what the globe draws) | 0.25° (what the flat map draws) |
|---|---|---|
| wind grid | 260,640 B → **196 KB gzipped** | 4.0 MB |
| temperature grid | 130,320 B → **66 KB gzipped** | 2.0 MB |
| pressure chart (4 hPa) | 265 lines → **103 KB gzipped** | the same |
| **per cycle** | **369 KB** | 6.2 MB |
| **× 1,460 cycles (4 a day × 365)** | **≈ 552 MB a year ✓** | ≈ 9 GB a year ✗ |

The archive keeps the **1° grids** — the same fields the 3D globe draws
("the SAME field, subsampled by the SAME worker run") — and the
**classic 4 hPa pressure chart**. The 0.25° grids would be 8.8 GB a
year, and the 0.05 hPa isobar lattice the worker actually cuts is
**39,320 rows (297 MB) a cycle**, which is 350 GB a year. The reader is
told the resolution (the API reports `resolution: "1deg"`) rather than
being given a map that quietly looks different from the live one.

**IT COPIES, IT DOES NOT RE-COMPUTE.** The archive copies the grids the
workers already published and exports the isobar lines the API already
serves, in the API's own item shape. There is no second implementation
of a field.

**THE READER SIDE** — ⚙ → **TIME MACHINE** → a date and one of the four
analysis times (00/06/12/18 UTC):

- **the moment rides in the URL** (`?at=`, the way a search rides in
  `?q=`), so a past map can be shared;
- **the three weather layers ask the archive where their grid comes
  from** — and their **own archived meta**, because the live meta
  describes today's analysis and a grid without its own meta cannot be
  drawn at all;
- **the layers hold their grid in MEMORY**, so choosing a moment must
  empty them and re-add them (`resetForArchive()`) — otherwise the
  reader would be looking at today's wind while the panel says March;
- **the news drawn is the news OF THAT DAY** — a new `until` parameter
  gives the window its other end, because `since` alone would be every
  story since that day;
- the section only appears when the archive has something in it: a
  reader must not be offered a date that cannot be served.

**MEASURED LIVE (Playwright, 2026-11-12):** with `?at=2026-11-12T06:00:00Z`
the wind layer fetched `/api/weather/archive/meta.json?field=wind&at=…`
and `/api/weather/archive/wind.bin?at=…` and drew **1,234 particles**
from the archived grid; the isobar layer fetched
`/api/weather/archive/isobars.json?at=…`; **0 page errors**.

**IT STARTS TODAY.** The fields were never stored, so there is no year
of history to recover — the archive begins with the first cycle it runs
on and fills as the days pass. `--all` backfills whatever is still in
the isobar table (which holds one cycle).

### The PRE-INDEX: the top queries answer in ~100 ms (2026-11-11)

Even at 0.5–2 s a search is a database query per reader, over a corpus
that grows every minute — and under load (the box ran at load average
**14**) the same query measured **0.5 s and 21.8 s on consecutive
calls**. So the popular queries are answered **in advance**:
`search_preindex` holds the answer, and a background job keeps it
current.

**WHAT IS STORED IS THE ANSWER, NOT THE STORIES.** The payload is the
pin list as the API serves it, slimmed of `word_freq` (711 KB of a
1.5 MB answer; the popup fetches its keywords on demand from
`/api/pins/:id/words` — the same slimming the browser-side store
already does). **The articles are never copied**: a stored answer points
at live rows, so a title, an image and a timestamp are always current.
Only the SELECTION is precomputed, and the job recomputes it.

**THE BUILDER CALLS OUR OWN API** (`worker/search_preindex.py`), so the
search SQL has exactly one implementation — a second copy in Python
would be a second implementation, and the second implementation is the
one that drifts. It sends **`X-Search-Fresh: 1`**, which makes the API
skip **both** the RAM cache and the pre-index: without that the builder
would fetch the stored answer and copy it over itself, and the store
would never get fresher.

**THE KEY CARRIES THE TIME WINDOW, NOT THE TIMESTAMP.** The frontend
asks for "24h" as `since=<now − 24h, snapped to the minute>`, so a key
built from the timestamp would change every minute and the stored answer
would never be found again — the trap the browser-side store already
documents. The window is derived from the AGE of `since`
(`windowKeyFor()`), and the key is `query | window | tag | limit`.

**WHICH QUERIES.** The **real demand** — `search_query_stats`, which the
search path now writes (it had ONE row in it: only
`/api/searches/save` wrote to it) — plus the observed log, plus a seed
list of the places people search for: the **largest cities of the world
by population** (the gazetteer the site already ships) and the country
names. **1,375 seed queries** in
`worker/data/search_seed_queries.json`.

**THE ANSWER SAYS HOW OLD IT IS.** A stored answer that does not say
its age is yesterday's news served as if it were this morning's: the
response carries `built_at` and the `X-Search-Source: preindex` header.
An entry older than six hours is **not served** — the live query is
right there.

**THE TIMER** (`deploy/xyzo-search-preindex.timer`, every 15 min) refreshes
only what has **aged past 20 minutes**, so each pass is cheap and
idempotent and the whole list stays current without the job ever
rebuilding all of it at once.

### Tests

`public_html/tests/search-region.bun.test.js` (25) — the two measured
collisions, the region from the stories, the world threshold, the early
framing, and the corroboration rule.
`public_html/tests/search-place-navigation.bun.test.js` — rewritten
against the shared function; the same assertions, a new home.
`public_html/tests/saved-searches.bun.test.js` (13) — the store is disk
not memory, it is capped, the key carries the window, the saved answer is
painted BEFORE the slow query is awaited, and the server's cache is
byte-budgeted.
`public_html/tests/search-country-hijack.bun.test.js` (17) — the
country-not-a-city rule: it runs the SHIPPED `city-engine.js` against the
real `cities.10k.json` (china/india/peru/florida/maine/korea/virginia
resolve to no city; chicago/rio/new/san/kansas c still do), and
`frameSearchRegion` against live-API fixtures (中国 and 日本 frame their
countries; Turkey-the-town does not; the US's 86°×360° box is not
fitted; the point-of-interest rule still binds the country clause).
`api/tests/pins-search-wordmatch.test.ts` and
`api/tests/tags-structural.test.ts` — **both mutation-checked**: they
fail against the pre-fix code.

---

## Wind Speed on Firefox — and the telemetry to study every browser (2026-11-14)

Owner, on the fifteen-overlay link
`https://xyzo.org/#2.1089,16.8750,3/density=max/overlay=…/iso=0.25:pressure/isoSrc=gfs/wind=particles:speed:100`:

> *"lets do some extensive testing and figure out why the wind dots dont
> move around very fast on firefox… what we can do to speed this up for
> all users… or give some speed tips or options for example less wind
> dots or controllable number? also we need someone on the server side
> to help us understand how slow or how fast various situations are
> running on various peoples browsers so we can log them and try and
> study them on what we can do to speed it up for all users."*

**THE TOOL IS `scripts/wind_perf_audit.py`** — Firefox *and* Chromium,
fresh contexts, one page load, then a **density sweep inside the same
page** (`WindLayer.setDensity()`, because re-loading fifteen overlays to
change one slider would measure the network four times and the slider
never). Its headline numbers:

```bash
python3 scripts/wind_perf_audit.py                                  # the owner's URL, both browsers, 100/50/25 %
python3 scripts/wind_perf_audit.py --browsers firefox --densities 100
python3 scripts/wind_perf_audit.py --no-wind                        # the SAME page, nothing animating
python3 scripts/wind_perf_audit.py --json reports/wind_perf.json    # full report
```

* `fps` / `p50` / `p95` / `worst` / `>100 ms` — how **choppy**.
* `dots px/s` — how **fast the marks travel on screen**, the perceptual
  number behind the complaint: the **median** displacement of the live
  pool over 500 ms windows (median, because a particle *respawns* — it
  teleports — every 1.3–3 s and a mean would report those jumps as
  speed). ~40 px/s is what this view manages at full pace.
* `particles` / `quality` — what the FPS guard did to the pool.
* Harness sanity: **60.4 fps on a trivial page in both browsers**, so a
  slow reading is the page, not the harness.

### What was wrong — three defects, each measured

**1. `step()` capped dt at 0.1 s.** That is a **speed limit** below
10 fps: the animation advanced by `min(1, 0.1/dt)` of real time, so a
4 fps device ran the field at 40 % of its pace. The model's prediction
and the tool's measurement agree:

| measured fps | 0.1 s cap says | tool measured |
|---|---|---|
| 8.2 | 37 px/s | 34.2 |
| 6.9 | 31 px/s | 29.8 |
| 8.8 | 40 px/s | 37.4 |

The cap is **`MAX_DT_S = 0.25`** now (real-time pace down to 4 fps; a
genuine stall is still bounded to ~17 px at the target speed, so a trail
can never be slashed across the map).

**2. The particles were stroked, and strokes are the most expensive
call this layer makes.** Instrumenting the live page: `stroke()` was
**80 % of every frame the wind spent inside canvas calls** — 21.1 / 21.2
ms a frame for 1,234 dots (Firefox), against 2.7–2.9 ms of fills. The
dot is now painted as **three concentric discs** (`PARTICLE_HALO_R`,
`PARTICLE_BLOOM_R`, then the core at its own radius), which reproduces
the annuli the strokes drew, because every inner disc paints over the
part of the outer one it covers:

| | stroke ms/frame | fill ms/frame | total canvas ms/frame |
|---|---|---|---|
| before (2 runs) | 21.1 / 21.2 | 2.7 / 2.9 | **24.2 / 24.6** |
| after (2 runs) | **0** | 12.9 / 15.3 | **13.4 / 15.7** |

**THE PICTURE IS UNCHANGED** — drawn both ways in one page: mean
absolute difference **0.54 / 255**, **0.63 %** of pixels differing by
more than 24 levels, lit-pixel coverage **1.011×** (the core reads a
touch more solid, which is the direction the dark-halo contrast fix was
already pushing).

**3. The Flow style advanced PER FRAME** (`step` px/frame with no dt,
`s.age += 1`), so at low fps the fibres crawled *and* a fibre lived four
times longer in wall-clock. Both are dt-scaled now, with the step
bounded at 3× so a stall steps forward instead of teleporting.

**AFTER** (same tool, same URL): **38.0–47.9 px/s in every run**, and
one run at **20.2 fps with zero frames over 100 ms** (p50 50.3 ms).

### What is NOT fixed — the overlay stack (Q-N39)

The frame cost grows with the number of overlays **on**:

| overlays (wind always on) | frame p50 | dots |
|---|---|---|
| 1 | 50 ms | 39 px/s |
| 4 | 100 ms | 42 px/s |
| 8 | 183 ms | 25 px/s |
| 12 | 234 ms | 19 px/s |

and hiding the other **35** Leaflet panes takes the very same page from
**267 ms → 50 ms**. That is the compositor re-stacking a deep pile of
full-screen layers every time one animated layer goes dirty: free on a
GPU, and the entire frame budget in software rendering.

**Three CSS candidates were tested, all rejected:**

* `will-change: transform` on every pane — no change (3.7 → 3.7 fps).
* `transform: translate3d(0,0,0)` — no change.
* `contain: paint` — **"3.7 → 23.8 fps"**, i.e. a lie: all 36 Leaflet
  panes are **0 × 0** (their children are absolutely positioned and
  paint outside the pane's own box), so the containment **clipped the
  whole map blank** — mean luminance 125 → 214, 15.6 % of pixels moved.
  With the panes sized first (`inset: 0`, giving 1440 × 900) the trick
  stops helping at all (5.8 fps). **A speedup that draws nothing is not
  a speedup**, and the pixel diff is the only reason it was caught.

The honest levers stay: fewer overlays while something animates, a GPU,
or fewer dots (25–400 %). See **Q-N39**.

### The speed tip is on the panel

The legend now prints the **live frame rate** beside the count —
`1,234 dots · 6 fps` (arrows are static, so no fps is shown there: it
would only print the display refresh rate) — and below 30 fps a tip:
**"Slow here — turn overlays off or lower the density for smoother
motion."** It clears itself the moment it stops being true. The density
control itself (slider **and** number box, in the URL as
`wind=<style>:<colour>:<density>`) shipped 2026-11-10.

### The server side: `client_perf` + `perf-report.js`

Owner: *"we need someone on the server side to help us understand how
slow or how fast various situations are running on various peoples
browsers."*

* **Migration `api/migrations/2026-11-14-client-perf.sql`** — one row
  per session per day per phase, natural key `(day, session_id, phase)`,
  granted to `xyzo_app` **inside the migration** (the first run failed 8
  of 12 tests with *permission denied for table client_perf*: migrations
  go in as a superuser, the API reads as `xyzo_app`).
* **`POST /api/analytics/perf`** — Zod-validated, 20/min per IP,
  `ON CONFLICT … DO UPDATE`, and a write failure is a log line, never a
  reader-visible error.
* **`GET /api/analytics/perf?days=30&phase=settled&group=browser|device|gpu|overlays|wind`**
  — the study: `items` + `count` + `totals`, with `pct_below_30fps` as
  the one number this table exists for. The **group expression comes
  from a fixed switch, never from the query string** (a GROUP BY is not
  a parameter place — an unknown group is a 400).
* **`public_html/perf-report.js`** — samples the frame cadence for 8 s
  twelve seconds after the map appears (`settled`), and again twelve
  seconds after the wind switches on (`wind`, with the dot speed). Two
  rows a reader a day, remembered in `localStorage["xyzo.perf"]`.
  **`gpu`** comes from `WEBGL_debug_renderer_info` and **`probe_ms`**
  from a fixed-shape canvas benchmark (120 filled circles, 20 frames) so
  a browser that withholds its renderer can still be told apart —
  llvmpipe/SwiftShader/Software means every pixel of every layer is
  being painted by the CPU, which is exactly the regime above.
* **Privacy:** the UA is parsed to two short strings (`"Firefox/153"`,
  `"Linux"`) before it leaves the browser; no IP is stored (the rate
  limiter only sees it), no raw user-agent, `view` is the URL hash (the
  map a reader built — `map_move` already sends the bbox), and
  `scripts/retention_prune.py` prunes it with the other telemetry.

**Two traps in the client, both caught by the tests:** `sessionId()`
asked for the **bare** `XyzoAnalytics` global inside its own
try/catch — the day that name stopped resolving it would have returned
null and telemetry would have stopped with *nothing in the log* (it asks
through `window.` now); and `obs.observe({ entryTypes: ["longtask"] })`
prints **two console warnings in Firefox** (it has no such entry type),
which is noise in the reader's console about our own file — support is
checked before it is asked for.

```bash
# the study
curl 'https://xyzo.org/api/analytics/perf?days=30&phase=settled&group=browser'
curl 'https://xyzo.org/api/analytics/perf?days=30&group=gpu'
```

Tests: **`public_html/tests/wind-slow-devices.bun.test.js` (12)**,
**`public_html/tests/perf-report.bun.test.js` (16)**,
**`api/tests/client-perf.test.ts` (11)**. The client suite **diffs the
payload's keys against the route's Zod schema**, so a field one side
adds and the other forgets fails a test instead of vanishing at the API
boundary.

**Playwright traps from this session, kept because they cost time:**

* A **fresh Firefox profile stalls on its FIRST navigation** — `goto`
  never commits within 60 s while Chromium commits in 1.5 s, and the
  *second* navigation on the same profile is fine. It is the profile's
  network warm-up (DoH/TRR + the predictor): with
  `network.trr.mode = 5` the first goto commits in **0.7 s**.
* `WindLayer._state` is the state **object**, not a function.
* A **backtick inside a SQL comment terminates the JS template
  literal**: the comment wrapped a type name in backticks, the template
  ended there, and the error surfaced 200 lines away as *"Expected ";"
  but found "typeof"*.



## Publishing to GitHub — GPL-3.0 (2026-11-14)

Published at **https://github.com/htmlfarmer/xyzo.org** under the
**GNU General Public License v3.0** — the full text ships as `LICENSE`.

**The licence covers the CODE. The bundled datasets keep their own terms.**
Every one is recorded in `docs/DATA_LICENSES.md` with its attribution and
the `verify()` gate that checks it: GPL-3.0 on our source does not relicense
Beck et al.'s Köppen grid (CC BY 4.0), Glottolog (CC BY-SA 4.0), the FAO
basins (CC BY-SA 4.0) or any public-domain US Government work. Those travel
with their own obligations, and `data-licences.bun.test.js` fails the build
if a published `meta.json` loses its `license`/`attribution`.

### What was scrubbed, and what replaced it

| Was | Where | Now |
|---|---|---|
| the **chosen production** password | `HANDOFF.md`, `scripts/setup.sh`, `scripts/backup-lightweight.sh` | `XYZO_DB_PASS` / `CHANGE_ME` |
| the **app-password** default × 72 files | DSN defaults in `worker/`, `scripts/`, docs, service units | `os.environ.get("XYZO_DB_DSN", "…CHANGE_ME…")`, `${XYZO_DB_DSN:-…}` |
| the **cities-writer / cities-reader** passwords | `worker/cities_cli.py`, `load_cities.py`, `build_cities_db.py`, `migrate_cities.py`, `pin_moderate.py`, `validate_cities.py` | `XYZO_CITIES_WRITER_DSN` / `XYZO_CITIES_READER_DSN` |
| the **legacy newsium** password | legacy newsium units + `PGPASSWORD=` prefixes | `NEWSIUM_DB_DSN` / `CHANGE_ME` |
| `ALTER ROLE … WITH PASSWORD '…'` | `api/migrations/…rename-newsium-to-xyzo.sql`, `api/cities_bootstrap.sql`, `scripts/rename-newsium-deep.sh` | `'CHANGE_ME'` |
| `Environment=XYZO_DB_DSN=…` alone | 5 systemd units | placeholder **+ `EnvironmentFile=-/etc/xyzo/xyzo.env`** (which systemd documents as overriding `Environment=`) |
| no `LICENSE`, clone URL `github.com/xyzo-org/xyzo` | repo root, `README.md`, `deploy/xyzo-story-link.service` | `LICENSE` = GPL-3.0; `github.com/htmlfarmer/xyzo.org` |

**Connection-string environment variables** — the DSN name is chosen by the
**database**, so a file that used to hard-code `…/wikidata` reads:

| Var | Database | Notes |
|---|---|---|
| `XYZO_DB_DSN` / `XYZO_DB_URL` | `xyzo` | the app DB — every worker and the service units default to it |
| `XYZO_DB_PASS` | — | used by `scripts/setup.sh` and the backup scripts to build a DSN |
| `XYZO_WIKI_DB_URL` | `wikipedia` | already documented; the API's wiki routes read it |
| `XYZO_WIKIDATA_DB_URL` | `wikidata` | **new** — the wikidata scripts used to share `XYZO_WIKI_DB_URL` |
| `XYZO_CITIES_READER_DSN` / `XYZO_CITIES_WRITER_DSN` | `xyzo_cities` | **new** — `cities_cli.py` keeps the two roles distinct |
| `NEWSIUM_DB_DSN` | `newsium` | legacy, pre-rename |

`api/.env.example` still shows `CHANGE_ME` and `api/.env.test` (tracked —
`bunfig.toml` loads it) carries `NODE_ENV` plus a `CHANGE_ME` DSN for the
isolated `xyzo_test` database.

### Deliberately NOT in the repository — all still on disk here

| Path | Size | Why it is out, and how a fresh clone gets it |
|---|---|---|
| `data/alternateNamesV2.txt` / `.zip` | 744 MB / 194 MB | **GitHub rejects any file over 100 MB.** A GeoNames build input — `worker/import_city_names.py` prints the download URL when it is missing. |
| `data/nn_models/**` | ~146 MB | Model checkpoints; already declared runtime artefacts in `.gitignore`. Rebuild with `scripts/setup-nn.sh`. |
| `geoip/GeoLite2-City.mmdb` | 62 MB | MaxMind GeoLite2 carries **MaxMind's own data terms**, not ours; refreshed weekly by `scripts/update-geolite.sh`. |
| `data/visual_baselines/`, `data/playwright_traces/` | ~55 MB | Generated test baselines/traces — already in `.gitignore`, were tracked from before the rule. |
| `logs/` (142 files), `backups/`, `.deploy-backups/` | ~1 MB | Runtime logs (one carried scraped third-party email addresses), a feed backup and 5 deploy tarballs — already ignored except `.deploy-backups/`, which is now ignored too. |

The publish set is therefore **2,749 files / 89 MB**, largest file under
25 MB. The **build inputs above are the only thing a fresh clone lacks**,
and each names the script that restores it.

### Re-running the scan

```bash
~/helpz/secretz --code .          # publish verdict → 0 critical / 0 warn
~/helpz/secretz --gate staged     # what `git commit` checks
~/helpz/secretz --gate tracked    # every tracked file
```

**`.secret-guard-ignore` is load-bearing.** It is the per-repo allowlist
both modes read (comments and blank lines are ignored), and every entry in
it is an idiom that *cannot* hold a credential — `= EXCLUDED.` (a SQL
upsert's own column), `os.environ.get(` (reading the environment is the
safe pattern), `NOPASSWD:` (the sudoers keyword), shell interpolation such
as `postgresql://$DB_USER:$DB_PASS@…`, and the path `api/\.env\.test`
which the test harness needs tracked. **It is checked into the repo, so the
reason each line is exempt travels with it** — add a broad pattern there and
you have built a hole in the scan.

### Publish ONE clean commit — the old history still holds the secrets

The local `.git` is **3.3 GB over 415 commits** and every one of those
commits still contains the pre-scrub passwords, so **this history must
never be pushed**. Publish a single fresh commit instead:

```bash
git remote add origin https://github.com/htmlfarmer/xyzo.org.git
git checkout --orphan publish     # index keeps the scrubbed tree, history is dropped
git commit -m "Xyzo — initial public release (GPL-3.0)"
git push -u origin publish
git checkout p5/remove-legacy-spawners   # the working branch, untouched
```

The 3.3 GB of history stays on this machine. See Q-N44–Q-N47 below for what
was **not** done.

---

## The Security Gates — what scans, what watches, what does not (2026-11-14)

**THE QUESTION THIS ANSWERS:** *"do we have a test case that we use
that regularly scans for passwords and security problems like sql and
others?"*

**SHORT ANSWER: the passwords had a gate; the SQL and its neighbours did
not.** They do now.

### The passwords — a gate that was already there, and runs by itself

| what | where | when |
|---|---|---|
| **the secret-guard git hooks** | `/home/asher/.git-hooks/pre-commit` + `pre-push` (`core.hooksPath`, so every repo on this box) | **every commit and every push**, on the staged/pushed content |
| **the per-repo allowlist** | `.secret-guard-ignore` | the idioms that CANNOT hold a credential — never a value that could be one |
| **`secretz --code` / `--gate staged` / `--gate tracked`** | `/home/asher/helpz/secretz` | on demand, and as the `security` stage of `scripts/ci.sh` |
| **`secretz`** (the whole-system sweep) | the same tool | shadow hashes, SSH keys, cloud credentials, shell history, process environment |

The hooks are why this repository can be **public**: a credential-shaped
string cannot reach a commit, and the two pushes made today both went
through the pre-push hook untouched.

### The rest — a scanner that is part of the regular gate

**`scripts/security_check.py`** walks the repository and fails on the
patterns that make a hole:

| rule | what it is | gated? |
|---|---|---|
| `sql-interp-python` | a value interpolated into a Python query (`execute(f"…")`, a concatenation, a `%`-format) | **gated** |
| `sql-unsafe-ts` | `sql.unsafe()` with an interpolated template literal | **gated** |
| `sql-interp-ts` | an interpolation inside a `sql\`…\`` tagged template | **gated** |
| `shell-injection` | `os.system()`, `shell=True`, a bare `eval()`/`exec()` | **gated** |
| `path-traversal` | a request value joined into a filesystem path | **gated** |
| `xss-unescaped` | an `innerHTML` with an interpolated value | report |
| `ssrf-schema` | a route whose Zod schema takes a URL and whose file has **no** SSRF guard | report |
| `sql-unsafe-var` | `sql.unsafe()` with a variable | report |

**THE REPORT-ONLY RULES NEED A HUMAN**, and they are kept short on
purpose — a list of 28 is read, a list of 263 is not. The XSS rule is
report-only because whether `${chips}` is safe depends on where `chips`
came from, which is a **data-flow** question a regex cannot answer.

**IT IS A RATCHET, NOT A WALL** — the same rule `scripts/ci.sh` follows
for every other stage. `scripts/security_baseline.txt` holds the
findings that exist today, and **the gate fails only on a NEW one**, so
the baseline can only shrink. **TODAY THE BASELINE IS EMPTY: the
codebase has ZERO gated findings.** The first thing the scanner found
was a real one — `scripts/system-status.sh` built a query with an
f-string — and it was **fixed**, not baselined:

```python
cur.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table)))
```

### THE GATE WAS PROVED ABLE TO FAIL

**A GATE THAT PASSES AGAINST BROKEN CODE IS NOT A GATE** — the rule this
repo learned the hard way on 2026-11-12. So:

- **`tests/test_security_check.py` (8 tests)** writes files that
  deliberately contain each dangerous pattern into a sandbox **inside
  the repo** (the rules are scoped to parts of the tree, so a sandbox
  outside the scope would be scanned and ignored and the test would
  pass for the wrong reason) and asserts the scanner **finds** them —
  and asserts a clean file produces **nothing**.
- **THE CI STAGE WAS PROVED RED.** An `sql.unsafe(\`… ${tid}\`)` probe
  was injected into `api/src/routes/analytics.ts`; `bash scripts/ci.sh
  --only security` went **RED** (`❌ security: 1 failures > baseline 0`),
  and the file was restored and the stage went green again.

**AND A PRE-EXISTING BUG IN `ci.sh` WAS FIXED ALONG THE WAY**: the
pattern that prints WHY a stage failed was
`grep -E "(fail\)|FAILED|ERROR|error TS"` — **an unterminated group**,
so `grep` printed *"Unmatched ( or \("* and the reader saw **no detail
at all** on a red stage. It is `grep -E "^\(fail\)|FAILED|ERROR|error TS"`
now.

### Where it runs

```bash
python3 scripts/security_check.py            # the gate (secrets included)
python3 scripts/security_check.py --report   # every finding, with the line
python3 scripts/security_check.py --write-baseline
bash scripts/ci.sh --only security           # the CI stage
```

**WHAT IT DOES NOT COVER** is in **Q-N50**.

## Known Issues & Next Steps (updated 2026-11-20)


Q-N51. **THE OVERLAYS ARE RELEASED RELIABLY NOW, BUT THE PIN FETCH IS
    STILL WHAT THEY WAIT FOR — and on a genuinely slow link that is the
    25 s abort, not the flush.** (2026-11-20.)
    The 11-20 fix guarantees the staged queue is *drained* — every exit
    from `fetchPinsForViewport` falls through a `finally` that releases
    it, so a link can no longer draw a basemap and nine ticked overlays
    with no tiles (measured 0 → 290 overlay requests across all three
    deterministic failure modes). **WHAT IT DOES NOT DO IS MAKE THE
    WAIT SHORTER.** The normal release is still "after the markers",
    and the markers still wait for `/api/pins/map`:

    * **The fetch has a 25 s auto-abort**, and a fetch that hits it
      releases the overlays at ~25 s rather than at the ~1 s a warm
      query takes. The backstop's ceiling is 30 s *because of* that
      abort (a shorter ceiling would beat it and stage the overlays
      ahead of their markers), so 25 s is the honest worst case for
      overlays on a link whose pin query never answers in time.
    * **The pin query itself can be slow** — `/api/pins/map` with
      `limit=2000&light=1` over a 31°×19° bbox. It answered in 0.5 s
      from this box and 10–18 s under Regular-3G throttling; the cold
      corpus-wide search query behind the text path is a separate,
      larger problem already tracked as **Q-N28**. Nothing in this
      session touched the query.
    * **This is a latency issue, not a correctness one.** The map is
      never missing overlays any more — but a reader on a slow link
      still watches the basemap for a while before the washes arrive,
      because the markers-first ordering the 11-12 fix introduced is
      deliberate and is measured (20 s of empty map without it).

    **Where it hurts:** the owner's nine-overlay link on a throttled
    connection. **The lever** is the pin query's own latency — worth
    attacking next, and it is the same lever Q-N28 names for search.

Q-N50. **THE SECURITY SCANNER IS A PATTERN SCANNER, NOT A DATA-FLOW
    ANALYSER — and it does not read the git HISTORY.** (2026-11-14.)
    `scripts/security_check.py` is the gate for the dangerous SHAPES. It
    cannot answer the questions that need a human:

    * **IT SCANS THE WORKING TREE, NOT THE HISTORY.** A credential
      committed and later removed is still in the repository's history —
      and the public `main` was cut as a fresh single commit, so the
      public repo does not carry it, but the **local** branches still do
      (Q-N45). **The scanner will not find that**, and neither will the
      git hooks: the hooks look at what a commit ADDS, not at what an
      ancestor did.
    * **THE XSS RULE IS LINE-BASED.** An `innerHTML` whose interpolated
      value was escaped three lines earlier is reported (a false
      positive), and an unescaped value that reaches the DOM through two
      assignments is **missed**. It is report-only for exactly this
      reason — 15 hits today, all of them read and all of them benign.
    * **THE SQL RULES CANNOT TELL AN IDENTIFIER FROM A VALUE.** A table
      name and a search term are the same shape in a string; only
      `psycopg.sql.Identifier` vs `%s` tells them apart, and that is a
      judgement the scanner leaves to the reader.
    * **IT IS NOT A DEPENDENCY SCANNER.** A CVE in `bun`/`pip` is a
      different tool and a different cadence.
    * **THE FOUR `ssrf-schema` REPORTS WERE CHECKED AND ARE FINE** —
      `agent.ts`, `analytics.ts`, `internal.ts` and `feedback.ts` take a
      URL and **store** it; they do not fetch it. The two routes that DO
      fetch a reader-supplied URL are guarded (`news.ts` by
      `assertSafeUrl`, `sniff.ts` by `safeFetch`), which is why the rule
      reports four and not six.
    *Fix if it ever matters:* a data-flow pass (taint analysis) would
    close the XSS gap; a history scan (`git log -p | secretz --code -`)
    would close the history gap. **Not fixed.**

Q-N48. **THE CHANGE MAP (`delta=`) IS A FLAT-MAP FEATURE — the globe and
    the time machine draw the ORDINARY chart while the URL says
    otherwise.** (2026-11-14.) The `delta=<window>` segment is written and
    read on the flat map only, and two other views carry the URL without
    honouring it:
    * **The 3D globe** carries the segment through as a "flat only part"
      (`view-handoff.js` → `flatOnlyParts()` in `globe.js`, which keeps
      everything the globe does not own) — so the globe's own URL still
      says `delta=24h` while the globe draws the **ordinary** pressure
      chart. The reader gets the change map back when they return to the
      flat map, so nothing is lost, but the globe's address bar promises
      a picture it is not drawing.
    * **The TIME MACHINE** wins over the window by design: `refresh()`
      draws the archived chart whenever an archived moment is selected
      (`if (state.deltaWindow && !archiveUrl)`), so a reader who picks a
      past moment while the change map is on sees the archived ORDINARY
      chart with `delta=24h` still in the URL.
    *Fix if it ever matters:* the globe would need a delta fetch and a
    contour of its own (it has none today), and the time machine would
    need to say so — e.g. the URL dropping `delta=` while an archived
    moment is selected. **Not fixed.**

Q-N49. **THERE ARE NOW THREE "CLEAR THE MAP" CONTROLS, AND THEY DO NOT
    MEAN THE SAME THING.** (2026-11-14.) The 🛰️ button in the bottom bar
    was changed to the satellite view (no overlays, the world view, the
    pins at max), and it now overlaps two older controls in the layers
    dropdown:

    | control | overlays | camera | base | opacities | pin density |
    |---|---|---|---|---|---|
    | **🛰️ Default map** (bottom bar) | **all off** | world (19.97 N, 0 E), zoom 2 | satellite | **left as they were** | **max** |
    | **↺ Clear** (layers dropdown) | **all off** | **the reader's own** | **the reader's own** | left as they were | the reader's own |
    | **⤢ Reset** (layers dropdown) | **all off** | world (20 N, 0 E), zoom 2 | satellite | **back to each layer's default** | medium |

    * **NONE OF THEM RESETS THE CHANGE-MAP WINDOW (nor the isobar step
      or colour).** They switch the isobar LAYER off; the layer's own
      settings live on. So a reader who presses 🛰️ and then ticks
      "Pressure lines" again gets the **change map** back, not the
      ordinary chart. It is the same rule as every other layer
      preference — a view is not a settings change — but it is worth
      knowing that "clear the map" does not mean "forget the change
      window".
    * **THE 🛰️ BUTTON DOES NOT RESET THE OPACITY SLIDERS.** It changes
      the VIEW; the stored opacity is a PREFERENCE, and the rule that
      applies everywhere else on this site is that a view is not a
      settings change. The ⤢ Reset is the control that resets them.
    * **THE TWO WORLD VIEWS ARE NOT THE SAME POINT.** The button's hash
      is the owner's own link (`19.9733 N`), the Reset uses the site's
      `WORLD_VIEW` (`20 N`) — a 3 km difference, invisible on the map.
    * **THE ✨ COOL MAPS CHIPS STILL OFFER THE HEAVY SHOWCASE TO A SLOW
      MACHINE.** The tier governs what AUTO-OPENS, not what a reader can
      click — a reader who taps "🌍 Earth portrait" on a phone gets the
      fifteen-overlay map, by choice. **Fix if it ever matters:** grey
      out the `high`-tier chips on a `low`-tier device, or warn.
    **Not fixed.**

Q-N44. **THE LIVE DATABASE PASSWORD WAS NOT ROTATED — only the repository
    was scrubbed.** The production password and the app-password default are out of the
    code, but the `xyzo_app` role still has whatever it was created with and
    `/etc/xyzo/xyzo.env` (root:asher, readable by the group) still holds a
    DSN. **Nothing is remotely reachable today** — `listen_addresses =
    localhost` and every `pg_hba` rule for `127.0.0.1`/`::1` is **`trust`**,
    so a garbage password was accepted all along and these values gate
    nothing. The day that changes is the day it matters: **before switching
    `pg_hba` to `scram-sha-256`, set a fresh password on every role and
    put it only in the env files** — otherwise the value in git history
    becomes a working credential. Not done here because it touches the live
    database.

Q-N45. **THE LOCAL GIT HISTORY STILL CONTAINS EVERY SECRET THAT WAS
    SCRUBBED.** Rewriting 415 commits was declined in favour of a fresh
    initial commit (see "Publishing to GitHub" above). Until that push
    happens, treat `.git` as sensitive: **never `git push` this history to
    a public remote.** A `git filter-repo` purge remains available if the
    old history ever needs to be published.

Q-N46. **INTERNAL INFRASTRUCTURE DETAIL IS STILL IN THE CODE, ON PURPOSE.**
    `192.168.1.3` (the LAN AI box) appears ~49 times as the default fallback
    URL, plus server paths (`/var/www/vhosts/xyzo.org`, `/home/asher/.bun`)
    and the username `asher` in the service units. All of it is **RFC1918
    or filesystem layout, not a credential**, and the code is unreadable
    without the fallback URL. Flagged rather than changed — decide before
    the first public push whether you want the paths genericised.

Q-N47. **TWO BUILD INPUTS WERE REDISTRIBUTED WITH NO LICENCE ROW AT ALL —
    the rows are written now, the gates are still missing.** **GeoNames
    `alternateNamesV2`** (CC BY 4.0) and **MaxMind GeoLite2** (MaxMind's
    own data terms — attribution required, redistribution governed by
    *their* agreement) were committed *inside* the repository — 808 MB of
    it — with no entry in the audit, because `docs/DATA_LICENSES.md`
    covers rendered overlays and basemaps while these are read by a worker
    and by the API. Both are **untracked now**, so nothing from either
    reaches GitHub, and **§7 of `docs/DATA_LICENSES.md`** records what they
    are, who reads them and what their terms say. **TWO GAPS REMAIN BY
    CHOICE:** the GeoNames import has **no `verify()`** (nothing checks the
    row counts or language split look sane after an import), and **no
    MaxMind credit is surfaced anywhere** — correct today, because no
    user-visible feature shows GeoLite2-derived city names, but it must
    appear with one if that changes.

Q-N33. **THE MOBILE AUDIT COVERS THE DOM-MARKER PATH ONLY — the canvas
    and event paths are fixed by the same helper but are NOT measured.**
    `scripts/search_mobile_audit.py` taps a **DOM marker** (the default
    render mode), so the **canvas-pin** path (used when the DOM markers
    are hidden — the "clusters" mode, or a canvas-only render) and the
    **event-marker** path (the heavy `/api/events/search` results, a
    30–90 s worker search) are covered by the source-pinned test and by
    the shared `openPopupWhenSettled()` helper, but nothing drives them
    on a phone yet. **The event path is the one worth measuring**: it is
    what a TOPIC search ("artificial intelligence") returns, and its
    popup is `buildEventPopup()`, whose mobile branch carries its own
    `.event-details-btn` / `.event-details-full` pair (a consistent one —
    the dead pair was the pin popup's).

Q-N33b. **THE CLUSTER FLIGHT AND THE POPUP FRAMING FIGHT EACH OTHER.**
    `maybeZoomToCluster()` frames the **CLUSTER** (every pin within
    30 km of the one tapped) and `keepPopupOnScreen()` then pans the map
    to frame the **POPUP**. When the tapped pin sits at the edge of the
    cluster's bounds the net view is neither: the popup is on screen —
    which is what the reader asked for — but the "zoom in to the cluster"
    intent is diluted. The two cannot both win, and the popup wins
    because it is what the finger was aimed at.

Q-N33c. **THE POPUP IS STILL TIED TO ITS MARKER.** If the marker is
    replaced while the popup is open (a zoom change regroups the pins
    and swaps a story marker for a cluster badge), Leaflet closes the
    popup with the marker; `restoreActivePopup()` re-opens it ~50 ms
    later — on the new marker, or as a standalone popup — so there is a
    brief flash. This is the pre-existing design (the restore path has
    been there since 2026-10) and it now recovers the ACTION BUTTONS too,
    which it did not before.

Q-N34. **THE TIME MACHINE'S ARCHIVE STARTS TODAY, AND ITS ISOBAR
   CHART IS THE 4 hPa ONE.** The wind, the temperature and the pressure
   were never stored, so there is **no year of history to recover** — the
   archive begins with the first cycle it runs on and fills as the days
   pass (a year of it is ~552 MB). The archived pressure chart is the
   **classic 4 hPa** one: the 0.05 hPa lattice the worker cuts is
   39,320 rows (297 MB) a cycle, and a year of THAT is 350 GB. A reader
   who wants the 0.1 hPa detail of a past day does not get it — the
   archive answers the chart a synoptic map is read from.

Q-N35. **THE `xyzo-isobars.timer` HAS BEEN "ACTIVE (running)" SINCE
   2026-11-06** — the service it triggers has not finished in five days,
   so the isobar worker is not running on its timer and the published
   pressure chart is not being refreshed on a schedule. (Measured
   2026-11-12, from `systemctl list-timers`; the tempmap and windmap
   timers are healthy and show a next elapse, so it is this timer and
   not systemd.) It is a pre-existing condition, not a change of this
   session — and it is why the archive's first entries carry the
   00:00Z analysis rather than the newest one.

Q-N38. **`/api/pins` WITHOUT A TIME WINDOW IS STILL A 17 GB SCAN — the
    caller was fixed, the endpoint was not.** The "🤖 AI Suggested" tab
    asked it for `min_confidence=0.85` with no window and the plan was a
    sequential scan of the whole `news_articles` table (17 GB,
    3.9 M rows): **measured, the query was still running after thirteen
    minutes.** The tab now sends a window (the panel's own filter,
    capped at three days) and answers in **0.9–3.4 s**. **The endpoint
    itself still has no guardrail** — `/api/pins/map` has had one since
    2026-10-31 (a world view with no window is floored at three days and
    says so in `guardrail.applied`), and `/api/pins` does not. Any other
    caller that forgets a window pays the same wall, and the fix belongs
    in the route: floor an unbounded list query the way the map query is
    floored, and report it.

Q-N39. **THE "AI SUGGESTED" TAB CAN STILL TAKE ~19 s ON A LOADED BOX,
    and a 320 px PHONE STILL CANNOT REACH THE ⚙.** The tab's world query
    (`/api/pins/map` with a 24 h window) measures **1.7–3.4 s cold and
    0.2 s warm**, but on the box as it was during this work (load average
    21) one audit run took **18.5 s** — the answer is cached by the API
    for 15 s and by the client for 60 s, so the second click is
    instant, but the FIRST click after a minute can be slow. Separately:
    on a **320 px** phone the bottom bar's content is still wider than
    the screen (**the language switcher alone takes 157 px**), so the ⚙
    hangs off the right edge and the **whole control menu** — density,
    hover mode, text size, export, "How to", and now the default map —
    is unreachable. That is **pre-existing** (it is why the new bar
    button is hidden below 560 px rather than pushing the ⚙ off a
    393 px screen), and it wants the language picker narrowed on a
    narrow screen rather than another control removed.

Q-N37. **THE BOX RAN AT LOAD AVERAGE 23 WHILE THE READERS' MAP WAS
   WAITING — AND HALF OF IT WAS THE PIPELINE'S OWN JOBS.** While the
   marker load was being measured (11-12), the box sat at **load average
   23**: this session's **pre-index builder** (now throttled — a 2-second
   pause and a 60-entry cap per pass ✓) beside the pipeline's
   **`worker.nn_batch_links --limit 3000 --min-score 0`** at **60 % CPU**
   and **`worker.nn_infer`** beside it. The link builder's own
   `--min-score 0` means it considers EVERY candidate pair, and 3,000 of
   them a run is a lot of database time on the same box the map reads.
   It is the pipeline's own job and it is not this session's, but it is
   worth a look: a score floor, a smaller batch, or a quiet-hours run
   would take the box off the edge.

Q-N32. **THE PRE-INDEX HOLDS ONE WINDOW AND ONE LIMIT, so the
   reader's other filters still pay the live query.** It is built for
   the site's DEFAULT time filter (`24h`) and the search path's limit
   (1,000) — the two a reader actually asks for. The "Show All" button
   (`all`), the 7d/30d filters and the 500-pin limit are **not**
   pre-indexed and fall through to the live query, which after the
   index fixes of 2026-11-11 measures **0.5–2 s** (and up to ~20 s
   when the box is loaded — it ran at load average 14 during this
   work). Building every window for every query would multiply the
   background work for answers nobody reads, so the extra windows are
   a deliberate deferral, not an oversight.

Q-N31. **While TYPING a country name the map still passes through a
   wrong city — the finished query is always right (11-11).** The
   country guard (`BIG_PLACE_NAMES` in `city-engine.js`) matches the
   **whole** query, so during "china" the keystroke path still sees
   "chin" — a prefix of Chinandega — and flies there for the debounce
   window until the next letter arrives; "india" passes through
   Indianapolis the same way. The completed query is correct (the guard
   fires at "china"/"india"), and the button / Enter / `?q=` paths never
   see the transient at all — but a fast typist sees the map flicker
   through the wrong city on the way. **No structural fix exists**:
   refusing every mid-word prefix would also refuse "chica" → Chicago
   and "spring" → Springfield, which is what the prefix rule is for, and
   the typing path cannot know the letters that have not been typed yet.
   Verified: the final state of every reported query frames the country
   (see "A search for a COUNTRY must not land on a CITY" above).

Q-N29. **A session was IDLE IN TRANSACTION for 16 hours and held back
   VACUUM — RESOLVED 11-11, but the LEAK that caused it will recur.**
   Found while studying the isobar endpoint's latency (11-10): pid
   **2782529**, `idle in transaction` for **57,557 s = 16.2 hours**, its
   last query `SELECT source_id, word_freq FROM news_articles WHERE
   status = 'extracted' …`. Its `backend_xmin` sits **420,245
   transactions** behind the database horizon, and Postgres will not
   remove a tuple that session might still see — so **nothing deleted
   in the last 16 hours can be reclaimed anywhere it has read.**
   **MEASURED CONSEQUENCES.**
   - `VACUUM weather_isobars` completed in **0.18 s and reclaimed
     NOTHING** — `n_dead_tup` stayed at **120,328 against 41,266 live**
     (395 MB for 41k rows, ~9.4 KB a row).
   - The **visibility map stays clear**, so an index-only scan on the
     new covering index still degenerated into **161,594 heap fetches**
     (= 41,266 live + 120,328 dead) and the planner preferred a seq
     scan — the index helps, but not as much as it should until the
     table is clean.
   - The same session holds back autovacuum on the 16 GB
     `news_articles`, where a `SELECT (SELECT COUNT(*) FROM
     news_articles WHERE status='extracted' AND location_id IS …)`
     from the API itself was measured at **104 s** (and five of them
     were running at once, 1:27 each).
   **RESOLVED 11-11 (owner's call).** The first pid had already gone
   by then, but **the same defect had recurred on a new one** — pid
   3528846, the identical query, idle **10.4 hours** — which is how we
   know it is a LEAK and not an incident. After
   `pg_terminate_backend(3528846)`:
   - the vacuum horizon went **410,068 → 3,355** transactions;
   - `VACUUM weather_isobars` took **3.96 s** (against **0.18 s and
     nothing reclaimed** before) and went **80,676 dead → 0**, table
     **397 MB → 241 MB** (36,938 → 21,240 pages);
   - the covering index's index-only scans now report **Heap Fetches:
     0** and run **6.3 ms / 7.0 ms** — against **1,577 ms / 606 ms**
     for the seq/heap scans they replaced, and against **161,594 heap
     fetches** while the visibility map was clear.
   Endpoint, owner's own `step=0.1` view: **18,361 ms → 238 ms**;
   conditional request **28,543 → 3 ms**.
   **NOTE ON THE COMMAND:** a bare `psql -c "…"` connects to a database
   named after your OS user and fails with *"relation weather_isobars
   does not exist"*. It needs the connection: `PGPASSWORD=… psql -h
   localhost -U xyzo_app -d xyzo -c "…"` (the DSN is `XYZO_DB_URL` in
   `api/.env`). **The shape to look for when it recurs:**
   `SELECT pid, state, age(backend_xmin), now()-state_change FROM
   pg_stat_activity WHERE state LIKE '%transaction%' ORDER BY 3 DESC;`

Q-N30. **`worker/learn.py` pulls ~3M JSONB rows into memory and holds
   a transaction open for hours — the leak behind Q-N29.**
   **ROOT CAUSE, NOT FIXED.** `update_source_keywords()`
   (`worker/learn.py:1144`) runs
   `SELECT source_id, word_freq FROM news_articles WHERE status =
   'extracted' and fetched_at >= <90 days>` and then **`fetchall()`s
   the whole thing** — ~3M rows, each carrying a `word_freq` JSONB
   document — while the `with connect()` transaction is still open.
   **MEASURED:** the process holding the connection was
   `python3 -m worker.run --limit 2000` at **RSS 4.9 GB, state `D`
   (uninterruptible I/O)** — it was swapping, which is why it sat there
   for 10 hours rather than finishing. The first stuck session ran the
   *same query*, so this recurs on every nightly cycle.
   The `SET statement_timeout = '600s'` already in that block exists
   because the scan itself takes 94 s+; **it does nothing about the
   memory or about the open transaction.**
   **THE FIX, NOT TAKEN HERE:** stop shipping the rows. Either stream
   (`cur.stream()`), or — better, since the loop below only ever needs
   a per-source, per-word total — **do the aggregation in SQL** with a
   `GROUP BY` over `jsonb_each_text(word_freq)`, so the database sends
   a few thousand ranked keywords instead of 3M JSONB documents. The
   worker needs a restart to pick either up, and it is the other
   session's file, so it is recorded rather than changed.
   **AND THE ISOBAR ENDPOINT IS STILL AT THE MERCY OF THE BOX.** The
   fix removed ~474 MB of per-request I/O, which is why it now answers
   in 201–302 ms instead of 4,147–30,250 ms — but the one query that
   genuinely has to run (`main`, 121–134 ms) still competes with the
   worker fleet, and the box was at **load average 17** for this whole
   study (`worker.run --fast`, `nn_batch_links`, `populate_embeddings`,
   `nn_infer` all running). Expect the number to drift with that load.

Q-N28. **The text search's own query can take 30–50 s — the map cannot
   frame the region until the STORIES arrive.**
   `GET /api/pins?q=<text>&limit=1000` ranks with `ts_rank_cd` over the
   whole `news_articles` table and then ships every row's `word_freq`
   JSON. Measured from this box (2026-11-09): **"nvidia" 49.9 s**,
   **"climate" 6.7 s**, **"wildfire" 3.7 s** — and the *same* query again
   **0.03 s**, so the cost is a **cold full-text scan**, not the row
   count. The event search beside it is the other half (**30–90 s**, a
   spawned Python worker).
   **WHAT WAS FIXED (11-09):** the map no longer waits for the EVENT
   search — it is started before the framing and awaited after it, so the
   region is computed from the pins as soon as they land (**measured on
   the live site: the map moves at 4.2 s instead of 14 s** on the
   owner's own query).
   **WHAT IS STILL OPEN:** the region cannot be computed before the PINS
   arrive, and the pins are the slow query — a reader searching a common
   word waits tens of seconds for the map to move. **The two ways out,
   neither taken here:** (a) a GIN/trigram index on the searched columns,
   so the ranking is not a sequential scan; (b) a smaller `limit` for the
   framing — the top **50** relevance-ranked rows already span the world
   for every topic measured ("artificial intelligence" 92.9° × 261.6°,
   "climate" 101.2° × 298.6°, "nvidia" 30.0° × 244.5°), so the region
   would be the same — but the reader is shown 1,000 matches, and that
   is a product decision, not a bug fix.

Q-N27. **The 3D globe's wind dots could NOT be verified in Firefox —
   this box has no WebGL in Firefox at all.**
   The owner asked twice for Firefox testing, and the 2D half **was**
   tested there (dots 6.14 % lit vs streaks 16.86 %, screenshots
   cropped and read by eye: circles with dark rings against long
   ribbons, 0 service-worker lines, 0 page errors). The **3D half
   could not be**: headless Firefox refuses to create a context —
   `AllowWebgl2:false restricts context creation on this system` — and
   forcing it (`webgl.force-enabled`, `webgl.enable-webgl2`,
   `webgl.software`, `MOZ_WEBGL_FORCE_ALWAYS=1`,
   `LIBGL_ALWAYS_SOFTWARE=1`) does not change it, so `globe.html`
   never mounts and there is no canvas to measure. Chromium renders it
   fine (900 particles, 5.85 % lit, 0 errors).
   **WHAT THIS DOES AND DOES NOT LEAVE OPEN.** The style *reader* is
   plain JS and **was** verified in Firefox (`readStyle() →
   "particles"` from the owner's own link), and the drawing code is
   identical in both engines — so the risk is not "Firefox draws it
   differently", it is "nobody has looked at the globe through a
   Firefox-rendered WebGL context". **The owner is the sensor here**:
   opening `https://xyzo.org/globe#…/wind=particles:speed` in a real
   Firefox with a GPU will settle it in one look. If the dots are
   wrong there, the parity test still pins the geometry, so the fault
   would be in MapLibre's canvas compositing rather than in the
   constants.

Q-N-1. **The 2026 FAO river network is rendered by the publisher — but
   our proxy now serves it.**
   "🌊 Rivers (FAO 2026)" is the real global network (more than a
   million reaches, a 10° box of it 28 MB of GeoJSON), so the LINES
   come from the publisher's WMS. That WMS is slow: **~2 s a tile**
   whatever the zoom (the cost is the query, not the rasterising) and
   **25-48 s for a whole-world tile**.
   **SOLVED ON 2026-11-06 — TWICE, AND THE SECOND TIME WAS THE BIGGER ONE.**
   (a) **The proxy** (`api/src/routes/faoRiversProxy.ts`,
   `/api/tile/fao-rivers/<level>/{z}/{y}/{x}`) caches the tile **on
   disk**, so the second reader of a view is a local file.
   (b) **We now render the low zooms OURSELVES** — the whole 2026
   network (8,477,883 reaches) was paged out of the publisher's WFS and
   rendered into a **static PNG pyramid** (1,364 tiles, 114 MB, z0-z4 × four
   detail levels). **The world view arrives in 0.71 s from our own disk
   and a country-sized z4 view in 1.63 s**, where the publisher wanted a
   minute-plus, and the publisher is not involved at all below z5.
   *What is left:* the **first** visitor to a **zoomed-in** area (z4+)
   still pays the publisher's ~2 s a tile, once, and it then lands in
   the proxy's disk cache and in the reader's browser.
   **THE ONE THING NOT TO DO HERE: change Leaflet's `tileSize`.** The
   tiles are **512 px IMAGES of the standard 256-px GRID** — the image
   size is free (the publisher's cost is the query, not the rasterising)
   and the browser downscales it into the slot. Changing `tileSize`
   itself moves the tile COORDINATES onto a 512-px grid, and every tile
   is then fetched from the wrong quadrant of the world: that is the bug
   behind *"the rivers look like they are not placed correctly"*. The
   request count is 35 for a 1400×900 screen; that is the price of being
   on the standard grid, and it is paid once.

Q-N-2. **The FAO WMS answers a 403 to a plain `urllib` request.**
   `urllib.request` gets **HTTP 403** from the publisher's WMS with its
   default `Python-urllib/3.11` agent; `curl` (its own agent), a
   browser agent and the build script's `xyzo-river-build/1.0` agent
   all get 200. The browser is unaffected — it sends a normal agent —
   but any future script that queries the WFS **must** set a
   `User-Agent` header, and the 403 reads like a block rather than a
   missing header.

Q-N-3. **The 2026 network has no names, so the labels come from a
   DIFFERENT dataset.**
   The 2026 edition's attributes are hydrology only — there is no
   `NAME` on a reach — so the river names are taken from the FAO's own
   classic rivers layer (`rivers_world_47950`), the same AQUASTAT
   family. The two agree on the rivers themselves, but the names are
   **basin** names, and the curation that turns them into river names
   is a **word list** ("Gobi Interior", "Lake Chad" and "Sahara" are
   dropped; 62,912 names went). A hand-written stop-list cannot catch
   every place whose name does not contain a place word, so **a few
   labels are still place names** — the audit saw "Cahokia / Joachim"
   and "Coles Creek", which are real watercourses but read oddly. The
   alternative — inventing names — is worse.

Q-N0. **The 0.25° wind and temperature are more accurate — and the
   COOL MAPS preset now pays 25.8 MB on a first visit.**
   The wind moved from 1° to 0.25° (the 1° grid was **78° wrong at
   Nairobi**) and the temperature followed it. That is the accuracy
   fix; the cost is real: **2.8 MB + 0.7 MB gzipped**, against 196 KB
   + 68 KB. The grids are only fetched by a layer that is ON, and the
   layers are OFF by default — **but the "✨ Cool maps" preset turns
   BOTH on**, so a first-time visitor to `xyzo.org` pulls the wind and
   temperature grids before they have asked for them. The
   temperature also used to warm its grid at **idle** (2 MB for every
   visitor who never switched the layer on); that warm is now gated on
   `state.enabled`.
   **MEASURED AGAIN ON 2026-11-08, AFTER THE PRESET BECAME THE OWNER'S
   OWN FIFTEEN-OVERLAY MAP: a bare `https://xyzo.org` load (a fresh
   browser profile = a first visit) pulls 25.83 MB across 395
   requests, 0 console errors.** The measurement has to raise the
   browser's resource-timing buffer first — **the default buffer holds
   250 entries and DROPS the rest**, which is how an earlier profile of
   this very map reported "250 requests, 4.3 MB" when the truth was
   572 requests and 43.5 MB. The breakdown:
   - **13.9 MB of `.bin` grids in 5 requests** — **ETOPO relief
     10.47 MB** (12,960,000 bytes on disk), wind 2.90 MB, SoilGrids
     0.52 MB, cropland 0.39 + 0.31 MB;
   - **4.4 MB of GeoJSON** — the rivers 1.86, the basins 1.48, the
     faults 0.65 and the GEM faults 0.42;
   - 2.4 MB of PNG tiles (141), 1.6 MB of proxied tiles (128), 1.4 MB
     of JSON (21 — `cities.10k.json` alone is 1.16 MB), 0.86 MB of
     isobars (the 0.25 hPa set) and 0.36 MB of pins.
   **THE SINGLE BIGGEST ITEM IS A FILE THE READER MAY NEVER READ: the
   ETOPO probe grid is 10.5 MB — 40 % of the first visit — and it is
   not the PICTURE.** The relief you see is a PNG tile pyramid; the
   12.4 MB grid exists for the hover probe, the "Everything" HUD row
   and the export surface's `sample()`. **It is not a bug, it is the
   repo's rule** — *"a layer that is switched on has its data in
   memory"* — and the export contract depends on it (`activeSurfaces()`
   keeps only surfaces that are on **and** loaded, *"exporting a layer
   that was never loaded would mean fetching 18 MB for nothing"*).
   *Remedy, in order of how much they give back:*
   1. **Make the ETOPO (and Köppen) probe grids lazy** — fetched when
      the probe is ARMED or the HUD first samples, not when the layer
      is switched on. That is **−11.5 MB**, but it needs an async
      `prepare()` on the export contract, or the relief band silently
      vanishes from an export. **Not done here: it touches the export
      contract, which is shared.**
   2. **Make the preset ship the COARSE wind pair** (`grid-1deg.bin` /
      `meta-1deg.json`, ~255 KB + 127 KB) and swap to the fine one when
      the reader zooms in — the globe already reads the coarse pair, so
      the files exist. This is the clean answer: a showcase map does
      not need a 0.25° field at world zoom. **−2.6 MB.**
   3. **Publish the wind at 0.5° instead** (~750 KB gzipped): the
      direction error falls from p90 41°/worst 78° to p90 18°/worst
      41°. It does not fix Sydney (41°, a feature finer than 0.5°), so
      it is a downgrade in accuracy, not a fix.
   4. **Keep 0.25° and accept the payload** — it is paid by readers who
      switched a layer on, and a full-screen wind map is what
      windy.com and every other weather site charges.
   *Impact:* first-visit payload and the TTFP SLA, which measures the
   first pin (the grids arrive in parallel, so the SLA is mostly
   contention — it swings 2.9 s to 14.7 s on this box, and
   `scripts/ci.sh` already retries it for exactly that reason). The
   map itself is correct and the layers are correct. **The owner asked
   for this map by name on 11-08** ("a default starting map on 'first
   load' for normal 'fast computer' users"), so the payload is a
   product decision, not a bug — it is recorded here so the next person
   to look at the numbers knows they were measured.

Q-N1. **The ocean currents are a 2014 field — and it is now LOUD.**
   NOAA CoastWatch's OSCAR mirror stops at the **2014-09-26** composite
   (measured 2026-11-04: 117 files, `oscar_vel7001`…`oscar_vel8026`,
   the number being the day count since 1992-10-05; the listing is not
   paginated and there is no newer name). The NRT product is behind a
   NASA Earthdata login, and the University of Hamburg's copy is
   restricted to institutional users (its THREDDS answers **401** from
   this box), so neither is reachable without a credential. The current
   STRUCTURE (the Gulf Stream path, the Antarctic Circumpolar Current,
   the equatorial currents) is unchanged, and the overlay now says so
   **where the reader looks** — the layer's name is **🌊 Ocean currents
   (OSCAR)**, its legend reads **"2014-09-26 · 12.1 years old — NOT
   live"**, and `meta.json` records the composite's own date and age.
   It is not a live field and it must not be presented as one.
   *Impact:* the animated currents show the right shape but not
   yesterday's eddies. *Remedy:* configure a NASA Earthdata token and
   point `scripts/ocean_currents_build.py` at the OSCAR **v2.0** NRT
   product. **Until then the build REFUSES to publish** — the
   freshness gate (`MAX_AGE_DAYS = 45`) fails, the published grid is
   left alone, the meta is refreshed, and `xyzo-ocean-currents.timer`
   exits non-zero **every day**, which is the alarm.
   *Also measured, and rejected:* the daily
   `nesdisSSH1day` geostrophic product is 37 days old and needs no
   credential, but its **absolute** velocity is wrong at the equator
   (+0.69 m/s eastward at 6°N where the South Equatorial Current must
   flow **west**) — it would trade a visible coastal hole for an
   invisible equatorial error. **And the coastal hole itself is the
   SOURCE**: OSCAR is an altimetry inversion, altimetry has no valid
   solution in the shallow Bight of Benin, and the daily SSH product
   has the **same hole in the same cells**.

Q-N2. **The globe's language overlay is still the POINT layer.**
   The **region** layer was built for both views, but the globe keeps
   the 8,889 Glottolog points (drawn by the same `circle` layer as the
   pins) because the region's polygons are 234 country shapes and a
   globe at country scale needs the points. Both views carry the region
   entry; the globe's point layer is the flat map's older one.

Q-N3. **The three new overlays are not on the globe's pin canvas.**
   The globe draws its own pins with MapLibre circle layers, so the
   earthquake markers there are MapLibre circles rather than the flat
   map's canvas ones — the same sizes and colours, but they are not the
   same renderer, and the globe's popup for an earthquake is not built
   yet (the flat map's is).

Q-N4. **The tour is shown once per BROWSER, and a reader who skipped
   it has to find the button.**
   The dismissal lives in `localStorage["xyzo.tourSeen"]`, so a reader
   who skipped the tour never sees it again unless they look for
   *How to* in the ⚙ menu or *Show me how this works* in the help
   panel. There is no "nudge" — the site does not interrupt a reader
   who has already been shown the tour. *Impact:* a reader who closed
   it by accident may never find it again. *Remedy:* if it matters, a
   "Replay the tour" line in the help panel's own list (the button is
   already there; it is the discoverability that would need work).

Q-N5. **The tile proxy is our own bandwidth for a third party's data.**
   Every NASA tile a reader loads comes through `xyzo.org` rather than
   straight from GIBS. Tiles are cached for an hour, so the second
   reader of a view costs nothing, and the route is rate-limited
   (400 requests a minute per IP) — but a busy hour is a busy hour.
   *Impact:* modest; the proxy serves tens of tiles a minute, not
   thousands. *Remedy:* if it ever matters, serve the tiles from a CDN
   cache in front of the route, or set a longer tile TTL (the tile for
   a given date never changes, so an hour is already conservative).

Q-N6. **The image proxy's rate limit is PER IP, and an IP is not a
   person.**
   It is now **300 requests a minute**, and a browser asking for an
   image is answered with the transparent placeholder rather than a
   429 — so the console stays clean for the reader. But the *bucket*
   is still shared: a mobile carrier's CGNAT puts thousands of readers
   behind one address, and an office NAT does the same, so a busy
   shared address can still exhaust the bucket for everyone behind it.
   *Impact:* blank images for those readers, not errors — the picture
   is missing either way, and the reader cannot act on it. *Remedy:* if
   it ever matters, key the bucket on something finer than the IP (a
   session id the client sends, or a cookie), or move the endpoint
   behind a CDN that can shed load per reader.

Q-N7. **A dead publisher's picture is still a dead publisher's picture.**
   The proxy makes it **silent** (a 1×1 transparent PNG instead of a
   red line in the console) — it does not make it **present**. The
   measured rate over the 400 newest articles is a handful of dead
   URLs, concentrated on two or three hosts (`static.klix.ba` was the
   worst at the time of writing). *Impact:* a blank tile where a photo
   should be. *Remedy:* the publishers' own feeds — `worker/image_scorer.py`
   can score a URL, and the dead ones can be dropped from the
   article's stored image so it is never asked for again.

Q-N8. **The GLOBE still seeds its particles from the SCREEN.**
   The flat map's ocean currents were fixed on 2026-11-04 to seed from
   the grid's **wet cells** — "seed from the DATA, not from the SCREEN"
   — because picking a random screen pixel and rejecting it unless the
   water there was moving seeded almost nothing over a continent.
   **`globe-wind.js`, the globe's engine for BOTH the wind and the ocean
   currents, still uses the old screen-pixel seeding.** *Impact:* on the
   globe, a view centred over a continent can seed very few particles,
   so the animation looks thin there while it runs perfectly.
   *Remedy:* build the globe's wet-cell list from its own grid, the way
   `ocean-current-layer.js` does — the two engines already share the
   same u/v sampling rules, so the fix is the same ten lines.
   Not fixed here because it is the globe's engine and the globe cannot
   be measured in this container (headless Firefox has no WebGL — see
   Q-N9).

Q-N9. **The globe could not be measured in FIREFOX on this box.**
   The container's headless Firefox has **no WebGL at all** (`FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS`
   — there is no GPU and Firefox's software GL path is not enabled in
   Playwright's build), so MapLibre never renders and the globe's
   overlays could not be exercised there. The flat map was measured in
   Firefox end-to-end (the seven audit scenarios, desktop and phone).
   The globe's ocean-current fix is the **same change** as the flat
   map's and is pinned by the same shape of test.
   *Remedy:* run `scripts/globe_audit.py` and
   `scripts/ocean_current_audit.py --browser firefox` on a machine with
   a GPU, or enable Firefox's software WebGL (`gfx.webrender.software`).

Q-N10. **The ocean currents are not in the Hover HUD's sampler list.**
   `ocean-current-layer.js` exposes `sampleAt(latlng)` and returns
   "Current 0.14 m/s (0.5 km/h) towards W", but the HUD's `SAMPLERS`
   list did not include it — the exclusion note reads "ocean currents"
   and means the **frozen ECCO picture**, which genuinely holds no
   numbers. The live layer does. *Impact:* in the HUD's "Everything"
   mode the cursor over open water read coordinates but not the current.
   *Remedy:* one entry in `hover-info.js`'s `SAMPLERS` plus a checkbox
   row — the machinery is all there. **DONE (2026-11-04):** the OSCAR
   layer is in `SAMPLERS` as **🌀 OceanCurrentLayer**, so the cursor
   over the sea now reads the current as well. **Still true of the
   frozen ECCO picture**, which is not a field of numbers and cannot
   be sampled — that exclusion is deliberate and stays.

Q-N11. **The isobar audit cannot tell WHICH product the published lines
   were cut from — and the GFS worker has a 1° fallback.**
   `worker/isobars.py` asks the filter server for `0p25` first and falls
   back to `1p00` when it cannot be served, but `weather_isobars` does
   not record which one answered. The audit now asks for **the same
   pair in the same order** (`fetch_raw_isobar()`), so it normally
   agrees with the build — but if the filter server served `0p25` at
   audit time and `1p00` at build time (or the other way round), the
   check compares the lines against a field they were not cut from and
   reports the **same false alarm** the resolution fix removed.
   *Impact:* low — the `0p25` filter endpoint has answered on every run
   since the fix, and the audit now prints the grid it used
   (`grid_deg: 0.25`) so a mismatch is visible rather than silent —
   but the failure would still look like a data bug. *Remedy:* record
   the product suffix in the `weather_isobars` row (a column, plus the
   value the worker used) and have the audit read it. Not done here: it
   is a schema change and a publish-path change, and the brief for this
   fix was the check alone.

Q-N12. **An isobar audit that could not RUN reads as a pass.**
   `main()` puts a check that failed to run (no database, no network, no
   stored lines) into `warnings`, not `problems`, so the audit prints
   *"✓ the three GFS overlays agree with each other and with the
   analysis"* after a check that never executed. The isobar check is the
   only one of the three that can fail this way, because it is the only
   one that reads the database. *Impact:* a green audit on a box where
   the DB is unreachable is a false green. *Remedy:* make "the isobar
   check did not run" a **problem** when the source was expected, or
   print the warnings next to the verdict. Left alone here: turning a
   missing dependency into a failure would flap the audit on every
   database hiccup.

Q-N13. **The wind-vs-pressure cross-check still reads the 1° field.**
   `geostrophic_check()` compares the published wind (1°) against a 1°
   MSLP message blurred with the two-CELL floor — 2.0° of blur — while
   the isobars the reader actually sees are cut from the 0.25° field
   blurred by 0.5°. The wind and the pressure are BOTH published on 1°,
   so the comparison is sound as a *wind-vs-pressure* check, but the
   "the flow runs along the ISOBARS" claim is made against a blurrier
   field than the isobars on screen. *Impact:* the measured median angle
   from geostrophic (24.1°) is a shade pessimistic for that reason.
   *Remedy:* rebuild the geostrophic field the same way the isobar
   check does — on the 0.25° grid, with the 0.5° blur — and interpolate
   the 1° wind onto it. Still out of scope: the 2026-11-04 fix was the
   **isobar** comparison, which had the opposite defect (it read a 1°
   field against 0.25° lines and reported a 1.35 hPa false alarm, now
   **0.029 hPa**), and the geostrophic check is a separate comparison
   whose own resolution is correct for what it compares.

Q-N14. **The soil-type map (HWSD v2.2) has no tap-to-read on a phone,
   is not on the 3D globe, and its legend table can go stale.**
   Three gaps, all known at ship time (2026-11-05):
   *(1) The probe follows `mousemove` only.* Touch has no hover, so a
   phone reader can see the 34 colours but **cannot ask what is under
   their finger** — the climate/temperature/soil layers answer that
   with a Probe button in the legend, and HWSD has none yet (the
   `blocksClick()` contract is already `false`, so arming one is a
   small addition, not a redesign). *Impact:* mobile readers get the
   picture without the names.
   *(2) Not on the globe.* Listed in `panel-parity.bun.test.js`'s
   `NOT_PORTED` with its reason (hotlinked FAO WMTS — same shape as
   WorldPop, which is not ported either). *Remedy:* a MapLibre raster
   source over the same GetTile template, plus the 34-class key in the
   globe panel.
   *(3) The 34 swatch colours are a SNAPSHOT of the service's
   `GetLegendGraphic`, taken 2026-11-05.* There is no build step that
   re-reads it (the overlay is hotlinked, so there is no `verify()` gate
   on the publish path). If FAO re-colours a class, the legend dot and
   the probe's name for that pixel silently disagree with the tiles.
   The probe's defence is the **"unknown colour" threshold** — a pixel
   far from every published swatch reports that instead of a name — but
   a *re-coloured* class that lands near another swatch would be
   mislabelled. *Remedy:* a scheduled re-fetch of GetLegendGraphic
   compared against `CLASSES`, alerting on drift.
   *Also noted:* `GetCapabilities` on this service **times out**
   (HTTP 524 after 150 s) — the URL was derived by probing `GetTile`
   directly, so the tilematrix list has never been read. It answers
   z0–z9 correctly at `maxNativeZoom: 9`; deeper zooms upscale.

Q-N15. **The USDA-orders chip has no scheduled rebuild, and its class
   table is a snapshot of the publisher's SLD.**
   The `usda` pyramid is built by hand —
   `python3 scripts/soil_build.py --layers usda` — because the source
   is a **static 2000–2022 ensemble** (v1.1.0) that is not expected to
   change; there is no timer, unlike the GFS-derived overlays. Two
   consequences, both known at ship time (2026-11-05): **(1)** if
   OpenGeoHub ever re-publishes the COG or re-issues the SLD, the
   published pyramid and its 12-colour table stay frozen until someone
   re-runs the build — and nothing alerts, because nothing is watching.
   **(2)** the 12 colours in `meta.json` were parsed from
   `s3.ecodatacube.eu/ifad/soil_order.sld` at build time; a re-issued
   SLD with different colours would make the legend and the probe name
   disagree with the tiles (the probe would still report the right
   ORDER — the LUT maps code→order, not code→colour — but the legend
   swatch could be the wrong hue). *Impact:* only if the publisher
   revises a dataset that has been stable since 2025. *Remedy:* re-run
   the build and diff `meta.json`; the `verify_usda()` gate (Kansas →
   Mollisols, Deccan → Vertisols, Siberia → Gelisols) runs on every
   build and fails loudly if the source moved under us.

Q-N16. **The 3D globe's own panel still starts open on a wide screen.**
   The 2026-11-06 *"don't start with the two control windows open"*
   rule was applied to the **flat map's** two windows (the Live Feed
   panel and the layers dropdown), which is what the owner pointed at.
   `globe.html` has a **third** panel — `#globe-panel` — and it still
   defaults to `startOpen = window.innerWidth > 640`
   (`globe.js`), though a remembered `settings.panelOpen` wins over the
   default, so a reader who closed it keeps it closed.
   *Impact:* a first visit to `/globe` on a laptop shows the overlay
   panel over the sphere; the map itself is still fully visible and the
   panel has a ✕ and a ☰ reopen (both pinned in
   `mobile-close-affordances.bun.test.js`).
   *Remedy, if wanted:* flip the default to closed the same way — but
   the globe's panel carries the layer switcher a globe reader needs
   immediately, so it is a product call, not a defect. Left alone
   deliberately rather than silently widened in scope.

Q-N17. **A timer tick and a manual worker run do not MUTEX.**
   *(The half of this entry that said the live GFS units were still on
   **6h** while `deploy/` said **15min** is **FIXED** — the owner ran it
   on 2026-11-06. The three files now differ from `deploy/` in **0
   lines**, all three read `OnUnitActiveSec=15min`, the next elapse
   moved to within a quarter-hour, and the first tick afterwards was
   observed doing exactly what the cheap no-op is for: ECMWF HEAD
   probes, no download. Note for the record: `daemon-reload` alone does
   NOT fix it — it only re-reads the files, so the unit has to be
   **edited** first; that missing step is why the first attempt changed
   nothing.)*
   **THE PART THAT IS STILL OPEN:** the isobar, temperature and wind
   workers have **no cross-process lock**. On 2026-11-06 the timer
   fired at 02:24 UTC while a manual `--source ecmwf` rebuild of the
   same field was already **65 minutes in**, and started a second full
   contour. Both wrote the same field at the same interval, each in
   one transaction, so the table came out **identical** — wasted CPU
   (two ~80-minute builds), not corruption. The no-op guard only
   protects a tick that starts when the *published* state is already
   current; it cannot see a build that is **in flight**.
   *Impact:* with the cadence now at 15 minutes, a manual run and a
   timer tick collide far more often than they did at 6 h — a
   double-build of the world is ~3 hours of CPU for one reader's
   curiosity.
   *Remedy if it ever matters:* a `pg_advisory_lock` taken for the
   whole build (the workers already hold one transaction, and
   `FOR UPDATE SKIP LOCKED` is the house pattern elsewhere — see the
   fetch-lease section), so the second entrant exits immediately
   instead of contouring the world.

Q-N18. **8 of every 20 published pressure levels are unreachable by
   any chip.**
   The published lattice had to become the **GCD of the whole ladder**
   (0.05 hPa) so that `step=0.1` and `step=0.25` are both exact on one
   dataset — see the System Health row for why the cheaper union was
   rejected. The union of the 0.1 and 0.25 lattices would have been
   **40 % less contouring**, but `weather_isobars_build.interval_hpa`
   is **one number** the no-op guard compares, and a partial lattice
   cannot be described by it.
   *Impact:* 40 % of the rows in `weather_isobars` are carried for
   nothing today (GFS: ~9,000 of 22,544 lines). Storage and build time
   only — no reader ever receives them, because no chip asks for a
   0.05 step.
   *Remedy if it ever matters:* publish the union and let the build
   record hold a **list** of lattices instead of one number — a change
   to the guard's schema, not to the client.

Q-N19. **The boot notice shares one opt-out with the other two, and the
   3D globe has no watchdog at all.**
   **(a) ONE KEY, THREE WORDINGS.** `sessionStorage["xyzo.offlineNoticeDismissed"]`
   is a single flag, so dismissing "The map didn't load." also silences
   a later offline or tile notice **in that same session** (and vice
   versa) until a recovery clears it. That is the shape the system
   already shipped for offline-vs-tiles and the owner asked for an
   opt-out, so it was kept rather than split — but the reader is opting
   out of *the notice*, not of any one explanation.
   **(b) `globe.html` DOES NOT LOAD `offline.js`.** It has no
   connection notice, no tile notice and no boot watchdog, so a
   `globe.js` that 500s or throws shows a bare page with nothing said.
   *Impact:* (a) is rare and self-limiting (a reload in a new tab is a
   fresh session); (b) only hurts a reader whose globe fails — the flat
   map, which is the product's front door, is fully covered.
   *Remedy if it ever matters:* (a) a per-reason key plus a
   `dismissedReason` recorded at dismiss time; (b) load `offline.js` on
   the globe page and point its probe at MapLibre's own load event
   instead of `window._xyzoMap`.

Q-N21. **The `.bin` grids went out UNCOMPRESSED — RESOLVED 2026-11-07.**
   AGENTS.md used to claim Caddy's catch-all `encode zstd gzip`
   compresses them to "about 1 % of their size (18.7 MB → ~150 KB)".
   **Measured: `grid_annual.bin` went out 17.8 MB with no
   `Content-Encoding` at all.** Caddy's `encode` only compresses a
   response whose `Content-Type` is on its compressible list, and
   `file_server` serves a `.bin` as `application/octet-stream`.
   **THE REMEDY ON RECORD BELOW WAS WRONG, AND IT IS WORTH KEEPING
   WRONG-ON-RECORD.** The plan was *"the correct `encode match`
   expression with the `>` prefix and the full default type list"* —
   re-measured on a throwaway instance, an explicit matcher list lost
   compression for **every type it named** (`big.js` and `big.css` both
   came back `enc=NONE`), and the response-header form
   (`header >Content-Type …`) matched nothing at all. `encode`'s
   `match` REPLACES the default set, so there is no form of it that
   *adds* `octet-stream`.
   **WHAT WORKS IS TO CHANGE THE TYPE THE EXISTING `encode` SEES:**
   ```
   @bins path *.bin
   header @bins Content-Type application/json
   ```
   `caddy adapt` confirms the handler order is
   `headers → encode → file_server`, so the override is in place before
   the decision is made. The Content-Type is a deliberate lie, spelled
   out in `/etc/caddy/Caddyfile`; nothing reads it — the client does
   `r.arrayBuffer()` and `sw.js` only looks for `text/event-stream`.
   `caddy validate` then a graceful `caddy reload`; backup at
   `/tmp/opencode/Caddyfile.bak-20261107`.
   **MEASURED AFTER:** soil `grid.bin` 12,960,000 → 535,247 bytes,
   cropland `grid.bin` 6,480,000 → 417,854, `class.bin` → 314,858,
   lightning `grid_annual.bin` 18.7 MB → 2.8 MB; across
   `public_html/data` **465 MB → 74 MB**, and the owner's 15-overlay
   link **43.5 MB → 18.2 MB (−58 %)** — with `.js`/`.css` still
   gzipped, which is the exact failure the remedy on record would have
   caused.
   *Still open:* nothing. Note `wind/grid.bin` compresses only 1.3×
   (u/v noise), so it stays ~3 MB.

Q-N20. **The service worker's `/data/` cache has no size limit, and the
   2026 river tiles are 114 MB of it.**
   The worker's `TILE_CACHE` is bounded (400 entries) because an
   unbounded tile cache eats the origin's storage quota and the browser
   then evicts *everything*, including the shell. But the `/data/` branch
   has **no limit at all**: it caches first, forever, and the 2026 river
   pyramid alone is **1,364 tiles / 114 MB** — and with a `?v=` build
   token, every rebuilt pyramid adds a *second* generation beside the
   first. The stale generation is never requested again, but it is never
   deleted either.
   *Impact:* a reader who uses the rivers layer and then visits it again
   after a rebuild carries both generations in their browser's storage.
   It is bounded in practice (one or two generations, and only for
   readers who switch the layer on), and the browser evicts the whole
   origin's quota before the map breaks.
   *Remedy:* give the `/data/` branch a limit too, **ordered so the big
   grids are evicted last** — the wind grid (4 MB) and the lightning
   grid are worth keeping, a superseded river pyramid is not. A
   generation-aware sweep (drop any `/data/rivers/fao/tiles/` entry
   whose `?v=` is not the current `TILE_BUILD`) is the cleaner fix and
   is what the proxy's own disk-cache sweeper already does.

Q-N22. **Three of the flat map's overlays can never be shown on the 3D
   globe, and the globe's panel does not say so.**
   `population-density-worldpop-1-km`, `soil-type-hwsd-v2-2` and
   `rivers-fao-2026` are hotlinked FAO **WMS/WMTS** services: a MapLibre
   raster source needs an XYZ `{z}/{x}/{y}` template, and these publish
   BBOX/GetMap (the rivers one carries a per-request dynamic SLD), so
   they sit in `panel-parity.bun.test.js`'s `NOT_PORTED` with that
   reason. **The round trip no longer loses them** (since 2026-11-07 —
   `registerGlobeKeys()` plus `flatHref(globeHash, incomingHash)` put
   them back in the "Back to the map" link), but **they still do not
   appear in 3D**: a reader opening a link like the owner's (15
   overlays) sees 12 and has no indication that three were left out
   rather than broken.
   *Impact:* a 3D reader sees a map missing three washes; a 2D reader
   who travels to 3D and back loses nothing.
   *Remedy if it ever matters:* either proxy the three into XYZ
   templates through our own tile proxy (the pattern
   `api/src/routes/faoRiversProxy.ts` already established) or grey them
   out in the globe's panel with the reason — the second is a UI change,
   the first is a real port.

Q-N23. **On a heavy link the wind's first frame arrives seconds after
   the map does.**
   The owner's link turns on fifteen overlays plus `iso=0.1`. Measured
   with Playwright on it: `_xyzoMap` lands **4.2 s** after navigation
   start (against **1.3–3.3 s** for a wind-only link at the same
   position), and the wind's first ANIMATED frame comes **0.2–7.6 s
   after that** — in one run the canvas was still not changing at 8 s
   and had recovered by 14 s. **The wind's own grid is not the cost**
   (`grid.bin` fetches in ~300 ms, and 0 from the browser cache); the
   cost is the defer chain of ~60 scripts before app.js plus booting the
   overlays the link asked for.
   **It is NOT the animation being slow either**: measured on that link,
   **8 fps with the wind ON and 8 fps with it OFF**, and **49 fps with
   the other fourteen overlays hidden** — the frame budget belongs to
   the rest of the link, and headless Chromium has no GPU.
   *Impact:* a reader who looks in the first second or two sees a map
   with no wind on it and concludes it is broken — which is what
   happened, and it is why the visibility fix (System Health, 11-07)
   had to be measured against a *settled* map rather than assumed.
   *Remedy if it ever matters:* start the wind's grid fetch as soon as
   the hash names the layer, ahead of the overlay init loop, and/or show
   a "wind loading" state in the legend. Neither is built.

Q-N24. **`scripts/globe_audit.py` occasionally logs a WebGL shader
   error that is not a regression.**
   Intermittently: `pageerror: Could not compile fragment shader:` (the
   message body is empty), roughly two runs in three of the full
   21-overlay audit, and never when the page is loaded with only the
   wind on (**0/5 with the 11-07 halo change, 0/5 on pristine
   `globe-wind.js`**). It cannot come from that change — the change is a
   2D `ctx.stroke()`, a different canvas context from MapLibre's WebGL —
   and the animation keeps running in every run in which it appears.
   *Impact:* noise in one tool's log; the audit's own verdict is
   unaffected.
   *Remedy if it ever matters:* filter `pageerror` for shader text in
   that script, or run it with `--use-gl=angle`/a real GPU. The audit's
   21/21 result is the thing to trust.

Q-N25. **The tile cache holds about ONE view, not a region.**
   `sw.js` bounds `TILE_CACHE` at `TILE_LIMIT = 400` so an unbounded
   tile cache cannot eat the origin's quota (Q-N20).
   **THE NUMBER CHANGED ON 2026-11-08 when the tile mirror landed.**
   Before it, only EXTERNAL-host tiles reached that cache — 184 entries
   for one view of the owner's 15-overlay link, about **two views**. Now
   every tile goes through `/api/tile/…` and branches there, so one view
   is the whole screen: **~300 of the 400 entries for a single view, and
   a second view evicts the first.** (The mirror branch is also what
   stops tiles landing in the UNBOUNDED caches they used to reach —
   same-origin assets went to `SHELL_CACHE`, which has no limit.)
   Everything is still *correct* offline (verified: network forced down,
   300/300 tiles render), it is the *coverage* that is thin: a reader
   who pans across a continent and then loses the WAN sees only the last
   screen.
   *Impact:* only a reader who both travels a long way AND then goes
   offline. Online, the browser's own HTTP cache covers the first hour
   anyway (`max-age=3600` on every mirrored tile).
   *Remedy if it matters:* raise `TILE_LIMIT` with a **byte** budget
   rather than a count (the entries are uneven — a Macrostrat tile is
   111 KB against Esri's 10 KB, so 400 entries is anywhere from 4 MB to
   44 MB), evicting by age. A count-only limit cannot express "keep
   ~50 MB", and it cannot express "keep the last four screens" either.

Q-N26. **Six builders still write their `.bin` files non-atomically.**
   The wind and temperature grids were fixed on 2026-11-08 (see the
   System Health row): `numpy.tofile(path)` opens `"wb"`, which
   **truncates**, so a reader landing inside the write gets a SHORT
   file — and the wind's client turned that into `state.enabled =
   false` plus a cached half-file that only a hard refresh cleared.
   **The same pattern is still in:**
   `worker/magmap.py` (eight `grid_*.bin` + `mask.bin`),
   `scripts/etopo_build.py`, `scripts/cropland_build.py`
   (`grid.bin` + `class.bin`), `worker/wavemap.py` (height + period),
   `worker/cape.py`, `worker/ivt.py`.
   **Whether it bites depends on the client, not on the writer:**
   `mag-layer.js` and `etopo-layer.js` both validate the byte length,
   so a mid-write read can break those overlays the same way;
   `cropland`/`cape`/`ivt`/`wave` do not validate, so they would render
   wrong values **silently**, which is arguably worse.
   *Impact:* only during the (sub-second) write window, and only for a
   reader fetching at that instant — but the result is cached, so the
   window's cost is paid for the rest of the day.
   *Remedy:* the same five lines in each — write a sibling
   `<file>.<pid>.tmp` and `os.replace()` it. **Not done in this pass on
   purpose**: every one of them is driven by its own systemd timer, so
   an edit only takes effect at its next publish, and changing six
   builders blind is worse than changing them one at a time against
   their own timer.

**From the 2026-11-01 offline work — what is still NOT offline**

Q-O1. **A first visit while offline cannot work, by construction.**
   The service worker precaches the app shell from `/index.html` and the
   assets that page names — it does **not** precache the world's tiles
   (millions of them). So offline works from the second visit onwards,
   for the area you have already looked at; opening a city you have
   never seen while offline shows the map frame with no basemap there.
   *Impact:* none while online — the first visit fills the caches.
   *Remedy if it ever matters:* an opt-in "cache this region" action
   rather than a background world crawl, which would be a multi-GB
   download nobody asked for.

Q-O2. **The tile cache is deliberately bounded at 400 entries.**
   Unbounded, it would consume the origin's storage quota and the
   browser would evict **everything including the shell** — the one
   thing that must never go. *Impact:* after heavy browsing, tiles from
   a long-abandoned area are the first thing dropped. *Remedy:* raise
   `TILE_LIMIT` in `sw.js` only alongside a quota check.

Q-O3. **Offline, the Live Feed shows last-known data or nothing.**
   The feed arrives over **SSE**, and a stream cannot be replayed: it is
   deliberately never cached (see the A/B in the System Health row).
   The client's own fallback is JSON polling of `/api/feed/live`, whose
   URL carries `since=<now>` — so the worker falls back to
   `ignoreSearch` and can serve an earlier response, but only if one
   was fetched during a visit where the worker already controlled the
   page. On a cold offline session the panel can stay on its
   loading/error state. *Impact:* the map, pins and every overlay still
   render; only the live news list is stale or absent, and the banner
   says the data is "already downloaded".
   *Remedy if it matters:* prime `/api/feed/live` once during install.

Q-O4. **`navigator.onLine` cannot see a dead tile host.** It reports
   the *connection*, so when only the imagery providers are unreachable
   no offline banner is honest — which is why `offline.js` counts
   Leaflet tile failures instead (8+ failures with failures outnumbering
   successes in a 10 s window → "Map imagery isn't loading"). *Impact:*
   a load where most tiles fail but a few succeed shows a patchy
   basemap with no notice; a load where **every** tile fails does show
   it.

**From the 2026-11-01 river-label fix — deliberate trade-offs, not bugs**

Q-R1. **Two *different* rivers that share a name get ONE label.**
   `chooseLabels()` dedupes by name, so a second "San Francisco" stream
   somewhere else on screen is not labelled. Accepted: the doubled-name
   glitch was the reported defect, and the isobar layer makes the same
   choice for same-level labels. *Remedy if it ever matters:* dedupe by
   (name, catchment) rather than name alone.
   Verified: `scripts/river_labels_check.py` (live DOM), 4 tests in
   `public_html/tests/river-layer.bun.test.js`.

Q-R2. **The label TEXT is Natural Earth's, so it is a river's own name**
   (including exonyms a reader may not recognise). "San Francisco down
   in South America" is the **São Francisco River** in Brazil — correct
   data, it just used to be printed twice. *Remedy if it matters:*
   prefer `name_en` and fall back to `name`, at the cost of local
   spellings.

**From the 2026-11-02 isobar work — Q-I1 open**

Q-I1. **On a PHONE, tapping any row in the layers dropdown closes it.**
   Measured on a 393 × 660 iPhone 14 Pro with real `touchscreen.tap()`
   events: tapping a base-layer radio, an overlay checkbox **or** the
   isobar detail chip all leave the panel collapsed — the tap works
   (the layer changes, the new lines are fetched) and then the panel
   shuts, so the next row needs the toggle again. **It is NOT specific
   to the isobar chips** — every row behaves the same, which is how it
   was recognised as pre-existing rather than introduced by the 1 hPa
   work.
   *Cause:* Leaflet's `Control.Layers` binds `mouseleave → collapse()` on
   the control's own container (`leaflet.js`: `S(e, {mouseenter:
   this._expandSafely, mouseleave: this.collapse}, this)`), and Chrome
   synthesises a `mouseleave` at the end of a touch sequence. The
   panel is then collapsed by a **mouse** event that the finger never
   produced. The app's own touch path (`collapseIfOutside`, which
   closes the panel only when the tap landed OUTSIDE it) behaves
   correctly — the collapse comes from Leaflet, not from here.
   *Impact:* on a phone the dropdown is a one-row-at-a-time affair. The
   map itself is unaffected, and a desktop is unaffected (the panel
   stays open — verified by clicking all five detail chips in a row).
   *Remedy:* remove Leaflet's `mouseleave → collapse` binding on touch
   devices and leave the app's `collapseIfOutside` as the only way a
   touch closes the panel. It is **not** done here because it means
   unwiring Leaflet's control event handlers, which the layers-panel
   machinery in AGENTS.md depends on — a change of its own, with its own
   test surface, rather than something to smuggle in with an isobar
   step.

**From the 2026-10-31 deploy — Q0 resolved 2026-11-01 (the size ceiling
was the wrong guard); Q1 still open**

Q0. ✅ **RESOLVED (11-01): the `app.js` size ceiling is removed.**
   Q0 existed because a one-line change could fail CI with an error that
   looked unrelated to the work. Asked directly — *"why do we have a
   limit on app.js size, for speed?"* — the answer turned out to be that
   it was **never a speed guard**, and it measured the wrong quantity:
   * **`app.js` ships as ~245 KB GZIPPED** (measured). The 850,000 figure
     is raw source, which gzip crushes 3.5×;
   * **all 62 scripts on the page are `defer`** (0 `async`), so a bigger
     file does not block rendering;
   * it is served **`Cache-Control: immutable` for a year**, so the cost
     is a one-time first visit, not per-visit render time.

   It was added 2026-10-29 in `fbb3ed5` as a "runaway-growth ceiling",
   and its rationale lived only in the test comment — the commit message
   never mentions it. Meanwhile it quietly became the binding constraint
   on every frontend change. What it cost while it existed (each recorded
   at the site where an assertion used to sit): the population overlay
   went into a **`generic-layers.js` registry** instead of being named
   inline, with README recording **"8 bytes"** of margin as the reason;
   state-abbrev search moved **3.4 KB** into `city-engine.js`; the
   layers-tap fix **deleted six uncalled functions and four dead consts**
   purely to get back under it; and the Cool-maps `keepView` fix had to
   relocate its own rationale into a test file to save 46 bytes of
   comment inside `app.js`. The six uncalled helpers and four dead consts
   that fix deleted (`getSpreadStats`, `_isHostBlocked`, `setBannerError`,
   `_isSourceImgBlocked`, `isWorldViewZoom`, `formatNumber`, plus
   `_searchMeta`, `_LINKS_CACHE_TTL_MS`, `AUTO_DISCOVER_MIN_CITIES`,
   `MARKER_MIN_ZOOM`) were **restored in `ada9b79`** once the ceiling
   went — the deletion was collateral, not a cleanup, and a gate you have
   to dismantle code to pass has stopped being a guard either way. They
   are genuinely unreferenced (verified across every `.js` and `.html`),
   so wiring them up is a separate decision. `MODE_BUTTONS` and `doShowAll`
   were correctly **kept** throughout, because a test and `index.html`
   use them.

   One correction that restoration repaired along the way: the original
   removal cut the statement `const AUTO_DISCOVER_MIN_CITIES = 1;` but
   left the rest of the LINE — `// At least 1 city with population` —
   behind as an orphaned, badly indented fragment. Worth knowing that a
   "delete the dead code" sweep that stops at a `;` can strand a
   trailing comment.

   **Removed:** all six assertions (`code-splitting`, `offline-layer`,
   `population-layer`, `ramp-palette`) **plus the AGENTS.md rule**. Each
   site keeps a comment pointing at `code-splitting.bun.test.js`, which
   carries the full reasoning — so nobody re-adds a ceiling by
   pattern-matching an old one.

   **What still stands is architectural, not a byte count:** code NOT
   needed at boot goes behind **`loadChunk()`**, and the chunk tests that
   assert that were kept. `app.js` may grow; it should just stay the
   part every screen needs. **Do not re-add a size assertion.**

Q1. **`scripts/validate-api.sh` is load-sensitive, so "DO NOT DEPLOY" is
   sometimes a false alarm.** Two separate checks are wall-clock SLAs:
   the TTFP threshold (`4000ms`) and test 9A's `time.sleep(1.5)` before
   asserting `drawn > 0`. On this box — shared with concurrent sessions
   and headless browsers, observed at **load 4–9** — the same code
   measured **4004ms** (fail) and **2360ms** (pass) eight minutes apart.
   The filter checks failed **4/4** for the real hash bug, then passed
   once it was fixed; the TTFP check failed once at +4ms and passed at
   load 9.18 on re-run. *Rule:* **re-run the gate before concluding a
   failure is real**, and check `uptime` — a single `✗` under load is not
   evidence of a regression. Distinguish by whether the assertion is
   about *behaviour* (`drawn == 0`, which was deterministic and real) or
   *elapsed time* (which moves with load).

Q2. **Nothing compares a frontend asset's `mtime` to its own `?v=`
   token, so a stale-token regression ships green.** `app.js` was
   stamped `202611010238` at 19:38 and edited at 19:42 for the
   clearSearch fix, then committed at 19:47 with no second bump — a
   4.5-minute gap in which any visitor cached the **pre-fix** bytes
   under the **current** URL. Every test that exists passed, because
   what they actually assert is narrower: `frontend-hygiene` checks that
   the *chunk* tokens match `app.js`'s token (they did — all three moved
   together), and the other token tests check presence, not age.
   *The check that would have caught it:* for each `?v=` in
   `index.html`/`globe.html`, `statSync(asset).mtime` must not fall in a
   **later minute** than the token (minute granularity, and the bump
   writes the file moments after computing the stamp — so same-minute is
   fine, later-minute is the bug). *Two traps when writing it:* compare
   against **each asset's own** token, never the newest token on the
   page, because `overlay-opacity.js` and `map-presets.js` are
   deliberately stamped independently by `bump_asset_token.sh` and would
   false-positive forever; and skip same-minute writes, or the test
   fails on every legitimate bump. *Also unguarded:* `pickSource()` /
   `HRRR_DOMAIN_QUAD` (see 0f) — a source-selection bug would pass the
   same way the `HRRR_DOMAIN_QUD` typo did.

**From the 2026-11-01 outage sweep — Q3, Q5 and Q6 were all fixed the
same day; Q4 is a deliberate decision and stays open by choice**

> **✅ Q3, Q5, Q6 are FIXED** — see the System Health rows for what
> changed. What follows is kept because the *diagnosis* is the
> hard-won part, and each entry records why the obvious fix was the
> wrong one.

Q3. ✅ **FIXED (11-01). Source rankings had been dead since
   2026-09-04** — and the obvious fix (make the client send
   `source_id`) was impossible. Of the **9,840 interactions in the
   preceding 30 days, ZERO carried a `source_id`** (the last one that
   had one is 09-04), so `calculate_source_rankings()` upserted nothing
   and `news_source_rankings` held **214 rows for 4,213 sources, all
   `last_calculated` 2026-10-04** — while `aggregates_refreshed`
   cheerfully reported `true`, because "no exception" is not "rows
   moved". **Why the client could not do it:** `/api/pins/map` returned
   neither `source_id` nor `article_id`; and a map pin is a *CLUSTER*
   of articles from several sources, so there is no single honest value
   for it to invent. `pin_id` was always NULL too, because the map's
   pins are `news_articles.id` (measured: **200/200 sampled ids are in
   `news_articles`, 0/200 in `pins`**) and the insert's
   `EXISTS (SELECT 1 FROM pins …)` correctly rejected them — `pins`
   holds **6 rows**: it is the user-submission table, not the map.
   **The fix is server-side and three-part:** `/api/pins/map` now
   returns `article_id`; both analytics endpoints resolve the article
   from an explicit `article_id` **or from the id sent as `pin_id`**,
   guarded by `NOT EXISTS (… pins)` so a genuine community pin can
   never be misread; and `source_id` is then **looked up** from that
   article rather than trusted from the request — so a caller that
   lies about `source_id` cannot inject attribution it does not own.
   That also means **no client change was needed** (an earlier draft
   patched `analytics.js`, which is served `immutable` for a year with
   **no `?v=` token at all** — the change would never have reached a
   cached browser). 7 tests in
   `api/tests/analytics-source-attribution.test.ts`.

Q4. **The 50 `NULL source_id` articles were left in place on purpose.**
   Re-attribution is **impossible**: all 50 have a sourced twin, and
   `UNIQUE (url, source_id)` rejects every attempt to attach one (the
   twin already owns that pair) — besides, attributing a story to a
   source that did not publish it would corrupt the very rankings Q3 is
   about. Deletion is **destructive**: `news_event_sources` and
   `news_story_links` are `ON DELETE CASCADE`, so removing them would
   chew into the 49 M-row story graph, and **23 of the 46 events** they
   belong to would be left with **zero articles**. They are legitimate
   Tier 1.4 orphans holding live story-graph data, so the repair was the
   *code*, not the rows. **If they ever need to go**, back up first and
   check `news_event_sources` for those 23 events.

Q5. ✅ **FIXED (11-01). Seven `xyzo-*.timer` units declared `Requires=`
   their own service.** Found while recovering the wedged fetcher:
   `systemctl stop xyzo-fetcher.service` **also killed
   `xyzo-fetcher.timer`**, because the timer `Requires=` the service —
   so any `stop` of a job silently disarmed its schedule and I had to
   `systemctl start` the timer again by hand. The trigger is `Unit=`
   under `[Timer]`, not `Requires=`; five of the seven already had an
   explicit `Unit=` and the other two (`nightly`, `queue-soak`) resolve
   correctly to the systemd default `<timer-name minus .timer>.service`
   — both verified to exist — so `Requires=` was pure footgun with no
   job depending on it (`emergency-stop.sh` only *echoes* those
   commands; `xyzo-full-setup.sh` just arms the schedule, which is the
   right thing for a setup script).
   **Removed from all seven** (`embeddings`, `fast-fetcher`, `fetcher`,
   `nightly`, `nn-infer`, `queue-soak`, `story-link`), then
   `daemon-reload`. **Verified by experiment, not by inspection:**
   * `xyzo-nn-infer.timer` still **fired at exactly 14:40:00** after the
     change, with `TriggeredBy: ● xyzo-nn-infer.timer` — proving `Unit=`
     is what triggers, not `Requires=`;
   * stopping that now-running service printed *"it can still be
     activated by: xyzo-nn-infer.timer"* and the timer stayed
     **`active` and armed for 14:45** — the exact action that had
     killed it before;
   * all seven are `active` + `enabled`, and `Requires=` now appears
     only as systemd's own defaults (`sysinit.target`, `-.mount`).
   Backups of the originals are in `/tmp/opencode/timer-backup/`.
   *Also worth knowing:* `NEXT` shows `-` whenever the triggered service
   is already running (a start on a running unit is a no-op), which is
   normal and pre-existing — it is not a dead schedule.

Q6. ✅ **FIXED (11-01). `extract.py:721 _batch_update_articles` could
   trip the 60 s timeout — and the diagnosis changed the fix.** A single
   row's `UPDATE` measures **~1.1 s**: the `trg_detect_cities` trigger
   (despite its comment saying "asynchronously (non-blocking)") runs a
   **synchronous `PERFORM detect_article_cities(...)`** that scans
   **8,264 `world_cities` rows with four `LIKE '%…%'` patterns and no
   usable index**, over title + the first 500 chars of body. So 60 s was
   never about the query being slow — **it was about WAITING**: a lock
   held by another transaction, or the box swapping. That is why my
   first instinct ("raise the timeout") was the wrong diagnosis: it
   would have hidden the real defect underneath.
   **The real defect was that the whole batch ran in ONE transaction** —
   there was no commit inside the loop at all (the pool committed on
   exit). Two consequences, both fatal: **one** failed statement rolled
   back *every* row of the batch (hours of Gemma extraction gone, which
   is exactly what the 10-29 nightly lost), and the transaction stayed
   open for the entire batch holding row locks on `news_articles` — the
   very shape that starves *other* writers into tripping
   `statement_timeout` themselves, and that blocks autovacuum.
   **This is the same defect `learn.py` already fixed on 2026-09-26**
   ("commit per source … rolling back 4,000 sources of work if one row
   failed"); `_batch_update_articles` had simply been missed.
   **The fix:** commit per row (a failure now loses at most one row and
   no lock outlives one `UPDATE`), plus `SET LOCAL statement_timeout =
   '300s'` per statement so transient contention is absorbed while a
   genuinely stuck row still fails loudly.
   **`SET LOCAL`, not `SET` + `RESET` — that detail is load-bearing:**
   after a failed row the transaction is ABORTED, so a `RESET` issued
   from a `finally` **itself raises `InFailedSqlTransaction`**, masking
   the original error and leaving the pooled connection dirty for every
   caller after us. `SET LOCAL` is transaction-scoped and dies with the
   row's commit/rollback, so there is nothing to reset and nothing to
   leak. (Verified: `1min → 5min → 1min` across a pooled checkout.)
   Slow rows (>30 s) are now logged instead of hiding inside a batch
   that either crawls or dies. 4 tests in
   `worker/tests/test_extract_batch.py` — including that a failure at
   row 2 leaves row 1 committed and row 3 never attempted.

**From the 2026-10-30 map-presets / default-map work — left deliberately
undone**

P0. **The default map is browser-local, not account-bound.** Everything
   lives in `localStorage` (`xyzo.defaultMapState`, `xyzo.lastMapState`,
   `xyzo.nextVisitMap`), so a user who sets up a beautiful default on
   their laptop gets the plain world view on their phone, and clearing
   site data resets all of it. *Impact:* the "save your own coolest
   map" promise holds per-browser only. *Why not now:* there is no
   account system to hang it on, and inventing one for this is a
   different project. *If wanted:* ship the three keys as a compact
   blob to a per-user record on login, and merge-on-login rather than
   overwrite.

P1. **The preset chips do not highlight the preset currently on
   screen.** Applying `⛈️ Storm watch` and then toggling one overlay
   off leaves the chip looking the same as every other chip — there is
   no "you are here". *Impact:* cosmetic; the map itself shows the
   state. *Why not now:* "the preset plus one tweak" has no honest
   answer for a highlight (dim? checkmark?), and a chip that lies
   about being active is worse than none. *If wanted:* compare the
   live state against each preset's parsed state and mark an exact
   match only.

P2. **The first-visit cool load is not opt-in.** A capable machine
   opens `🌍 Earth portrait` (six overlays, including two NASA GIBS
   pyramids and the SoilGrids tiles) before the user has asked for
   anything. *Impact:* a larger first payload than the old bare world
   view, and a user who wanted "just the news map" must press ↺ Reset.
   The hardware gate and the light-preset fallback bound the cost, and
   the auto-save means the next visit is whatever they left. *Why not
   now:* the owner's spec was explicitly "if your computer specs are
   good enough it will load the coolest map". *Watch:* first-load
   bytes/latency for new visitors; if it bites, gate on connection
   type more aggressively or show the chips and let the user pick.

P3. **`bump_asset_token.sh` stamps by regex over two HTML files and
   one JS constant.** It handles `?v=` references and globe.js's
   `const V`, nothing else. A future token site (say, a JSON `build`
   field) would need a new branch. *Impact:* none today. *If wanted:*
   the per-file sections could read a small manifest instead of
   hard-coding the three locations.

**From the 2026-10-30 magnetic-field extension — left deliberately undone**

M0. **The magnetic GeoTIFF export carries the ACTIVE mode's four bands,
   not all eight.** `surface.bands` is a getter and `sample()` returns
   exactly what `bands` names (a literal 8-band list beside a 4-value
   sampler would ship four silently empty bands), so "take F home" means
   switching the selector to Total force first — and ΔF/ΔH/ΔI need a
   second switch to "Change per year". *Impact:* a data user who wants
   main field + rates in one file has to export twice. *Why not now:*
   loading all eight planes up front doubles the idle fetch from ~510 KB
   to ~1 MB raw, and "export what you are looking at" is the exporter's
   whole contract. Fixing it properly means an explicit "all bands"
   affordance that warms the other mode first.

M1. **X, Y and Z are computed and verified but not published as
   overlays.** They are the vector decomposition of D/F/H/I (D, F, H, I
   carry all of their information), and NOAA tabulates them — but seven
   components would have meant 14 selectable fields. *Impact:* none on
   the map; they exist only in `verify()`'s gates. *If wanted:* add three
   `FIELDS_SPEC` entries, three ramps, three line families and three
   chips — the plumbing is per-field now, so it is a worker change, not
   an architecture change.

M2. **The globe has no magnetic probe.** The flat map reads D/F/H/I (or
   the four rates) at the cursor and feeds the Hover HUD; the globe has
   no pointer probe for *any* overlay — pins only. *Impact:* you can see
   and pick a field on the globe but not read a number off it. *Why not
   now:* it is a gap common to every globe overlay (temperature and
   lightning too), so fixing it only for mag would be arbitrary.

M3. **NOAA's published shapefile contours are not used as an independent
   witness for our contour geometry.** The overlay computes every line
   from the same `WMM.COF` those shapefiles were derived from (the
   documented choice — they are lines with no grids), so the *field* is
   cross-checked against NOAA's test values but the *line placement* is
   only checked by `test_magmap.py`'s level/coverage assertions.
   `data.ngdc.noaa.gov/geomag/wmm/wmm2025/shapefiles/` (81–231 MB) would
   let `verify()` compare our polylines against theirs — the same
   independent-witness pattern as `gfs_verify.py`'s cross-field checks.
   *Why not now:* it would put a large, intermittently-available NCEI
   download on the build path, which is the one thing the vendored
   coefficient file exists to avoid. It belongs as an **opt-in** audit.

M4. **The image-proxy transient-TTL fix is committed but NOT live yet.**
   `api/src/routes/imageProxy.ts` now bans a timed-out or 5xx/403/429
   fetch for 60 s instead of 30 minutes (see "Console audit" above), but
   `xyzo-api` runs `bun run src/server.ts` straight from the working
   tree and **another session has uncommitted `api/src/routes/feed.ts`** —
   a restart to pick up my file would also load theirs, mid-edit.
   `validate-api.sh --quick` passes (it bundles all of `src/server.ts`,
   so both files compile), which means the restart is safe whenever the
   other session finishes and does it. *Impact until then:* a photo whose
   first fetch hit a transient failure stays 404 for up to 30 min rather
   than 1 min — the console shows the same 404 either way.

**From the 2026-10-30 crash cleanup — left deliberately unfixed**

0a. **`JSON.stringify(x)::jsonb` double-encodes through postgres.js.**
   Probed directly: a parameterised string cast straight to jsonb is
   stored as a jsonb **STRING** (`jsonb_typeof` = `string`), so
   `col->>'key'` returns NULL and nothing can find the row again. The
   house convention already avoids it — `sql.json()` in
   `api/src/queue/jobQueue.ts:111` and `statusWriter.ts`. But **~15
   call sites still use the bare form** and are therefore storing
   strings: `routes/analytics.ts:253,1073`, `routes/community.ts:783,810,1018`,
   `routes/events_calendar.ts:367`, `routes/collab.ts:169,215,230,297,347,354,376`,
   `routes/pins.ts:150`. The new `/api/pins/:id/report` route uses
   `sql.json()` and its test asserts the round-trip. Fixing the other 15
   needs each **reader** checked too (a reader that does `.toJSON()` or
   `JSON.parse` on the string is compensating for the bug and would
   break if the writer is fixed), so it was not done blindly here.

0b. **~35 % of the stash's lost work was recovered; the rest is still
   stashed.** `stash@{0}` held ~110 lines of `app.js` that never landed.
   Recovered: the **combined feedback dialog** (the only part that was a
   complete, unreachable *feature* — its Report tab also needed an
   endpoint that did not exist). **Not** ported, still in the stash:
   the popup's `popup-datetime` line, the `event-source-read` /
   `live-source-read` "Read ↗" markup, `live-item-place` + the Sources
   ▾ button, the `showLocationDenied` geolocation UX, and the
   fly-to-then-`zoomToShowLayer`-open-popup. Each is cosmetic/UX and the
   current tree has since diverged, so they must be **re-implemented by
   hand, never applied** — the stash is half-finished and calls into a
   display dropdown that has no HTML. `stash@{1}` ("wip") is redundant
   and safe to drop; `stash@{0}` is **not**.

0c. **`public_html_dev/` is a stale parallel fork AND a live site.**
   `/etc/caddy/Caddyfile:646` serves `nova.xyzo.org` from it. It is
   **a month behind** prod `app.js` (681 KB vs 804 KB) and predates
   every overlay, the export engine, the hover HUD and the globe.
   `deploy.sh:88-95` copies dev → prod (mtime-guarded), and
   `scripts/check_dev_merge.sh:19-20` literally `cp`'s the stale dev
   `app.js` over production to "simulate" a merge. Re-sync prod → dev or
   retire the vhost — but do not run `check_dev_merge.sh` as it stands.

0d. **`transport-layer.js`, `salinity-layer.js` and `ocean-layer.js` are
   ~60 % duplicated** with no shared helper (diffs of 155 and 175 lines
   against a common core). Every fix to the antimeridian-blit / async
   `done()` pattern must be applied three times — the exact "second
   source of truth" AGENTS.md warns about.

0e. **Two commits share one misleading message.** `aa9f5ea` and
   `a463a31` are both titled "chore(queue): server.ts no longer gates
   pool boot on env flag", but they add *different* routes
   (story-tree vs weather). The history is correct; `git log --grep`
   is not.

0f. **ECMWF IFS is served live but absent from `docs/DATA_LICENSES.md`.**
   `/api/weather/isobars` now returns `source: "ecmwf"` (566 lines)
   alongside GFS. ECMWF IFS is **CC BY 4.0** — attribution required —
   and neither the licence audit nor README/AGENTS.md mention it (both
   still describe the source as NOAA GFS only). No test covers
   `pickSource()` / `HRRR_DOMAIN_QUAD` either, which is how the typo in
   0h survived. **PARTLY ADDRESSED (2026-11-04):** `docs/DATA_LICENSES.md`
   now has rows for the ECMWF and HRRR isobar paths, and the **reader
   can now ask for ECMWF by name** — the isobar legend's analysis picker
   (**Auto · ECMWF · GFS · HRRR**) requests `source=ecmwf` explicitly,
   and `SOURCE_ATTRIBUTIONS` in `isobar-layer.js` names the analysis in
   the map's attribution bar with its licence ("Pressure lines based on
   data and products of the European Centre for Medium-Range Weather
   Forecasts (ECMWF) — CC BY 4.0"). **STILL OPEN:** the licence *audit*
   (`data-licences.bun.test.js`) does not check the ECMWF or HRRR
   attribution strings, and `pickSource()` / `HRRR_DOMAIN_QUAD` still
   have no unit test of their own.

0g. **Three modules with no test coverage**: `cape-layer.js`,
   `ivt-layer.js` (now registered in `app.js`, so they at least load)
   and `worker/water_sources.py` — a 52 KB subsystem that is untracked,
   undocumented, has no systemd unit and no test, and whose registry
   `worker/data/water_sources_data.json` only appears on `--apply`
   (which does `INSERT INTO news_sources`).

0h. **API tests must be run from `api/`.** `api/bunfig.toml` sets
   `envfile = ".env.test"`, and bun only discovers bunfig from the
   working directory. `bun test api/tests/` from the repo root silently
   loads no env, and `jobQueue.ts:4` calls `getDb()` at module scope —
   so the module graph aborts mid-evaluation and **153 tests fail with a
   misleading `Cannot access 'state' before initialization`** from
   `workerPool.ts`. Always: `cd api && bun test`.

0i. **`maps/World_Koppen_Gerrit_Hendriksen.kml` (9.7 MB) is still
   tracked.** It is the *superseded* Peel et al. 2007 source — the
   CC BY-NC-SA exposure that `docs/DATA_LICENSES.md` §4 records as
   resolved. The Beck et al. 2018 replacement is in use; the old KML is
   now dead weight carrying a restricted-licence file.

0j. **`worker/isobars.py` has no `verify()`** while every sibling worker
   does. The isobar cross-check lives only in `worker/gfs_verify.py`
   (`isobar_check()`). The Data Quality row that claimed
   `isobars.py::verify()` existed was corrected 2026-10-31; the gap
   itself — one worker with no gate of its own — is not fixed.

0k. **No overlay `meta.json` is actually committed.** The blanket
   `public_html/data/` rule in `.gitignore` ignores the *directory*, so
   git cannot re-include anything beneath it and only
   `data/temp/meta.json` is tracked (force-added). The other ~29 licence
   records — including the `license`/`attribution` fields
   `data-licences.bun.test.js` exists to enforce — are on disk only.
   **The licence gate therefore passes on this box and has nothing to
   read on a fresh clone**, which makes it weaker than it looks. Fixing
   it needs all three of: `public_html/data/*`, `!public_html/data/**/`
   (or git will not descend into the ignored dirs) and
   `!public_html/data/**/meta.json`. That is a deliberate behaviour
   change to a long-standing rule, so it was left for review rather than
   folded into a cleanup commit.

0l. **Other README/AGENTS.md claims found false and NOT fixed here**:
   README:2871 says "there is no `xyzo-embeddings.timer`" — it exists,
   is installed and is **enabled** (AGENTS.md says the opposite, and is
   the correct one); README:115 says `frontend-hygiene.bun.test.js` has
   18 tests, it has 23; README:105 and AGENTS.md both say the hover HUD
   reads **13** layers, `hover-info.js` has **15**; README:3358 points
   at `worker/retention.py` (it is `scripts/retention_prune.py`) and
   README:3261/3367/3452 at `system-health-check.sh`, which is not in the
   repo at all; AGENTS.md:1198 points at
   `worker/wildlife_registry_patch.py` (it is `scripts/…`) and still
   cites `public_html/viz.js` (deleted) and `langPane` z-index 358
   (it is now **364**).

**Mobile / 3D-globe — from the 2026-10-30 review, left unfixed**

0m. **The control menu's own buttons are still ~25 px tall on a phone.**
   *(Partly fixed 2026-10-30: the 44 px chip rows — density, hover,
   text-size — and the 36 px "Save this view" / "Export" buttons were
   raised to the floor during the clear-band work. The gaps remain.)*
   Still **25 px high**: the **MAP / MY STYLE / LAYERS / EXPORT / TOOLS
   section labels** in `.control-section-label`, the three **TOOLS
   action rows** (Today's digest, Legend, AI / Help — 36 px), and
   `.control-menu-inner`'s own `padding: 6px 0`. The layers dropdown got
   a `@media (pointer: coarse)` rule that raised its sliders and rows;
   the control menu never did. Fiddly-but-working, not blocked.

0t0. **The chrome edges are measured, but nothing enforces the
   relationship between them.** `publishChromeEdges()` writes
   `--bottom-bar-top` and `--top-chrome-bottom` independently. If a
   future change makes `#top-bar` taller than the viewport minus the
   bottom bar, `max-height` goes **negative** and the menu collapses to
   zero rather than failing loudly. A `Math.max(0, …)` guard would turn
   that into a visibly broken-but-tappable menu. Not added because no
   current breakpoint produces it, and a guard with no reproducer is
   speculation.

0t1. **`#help-me-btn` is hidden while ANY of the three dropdowns is
   open, not only while it would actually collide.** The pill is hidden
   for the time and markers dropdowns too, where it never overlapped
   them. Chosen deliberately: the three share `body[data-dropdown-open]`,
   and a per-dropdown rule would be three selectors to keep in sync for
   a 150 ms cosmetic difference. If someone wants it exact, key the flag
   to the open menu's id and select on that.

0n. **A very narrow phone + the A++ text size cramps the popup's
   headline.** The width bottoms out at its 160 px floor on a 320 px
   screen at 130 %. No close button is affected — the ✕ is now always
   inside the viewport — but the text gets tight. Worth a per-breakpoint
   width rather than a floor.

0o. **`public_html_dev/` (nova.xyzo.org) has none of this.** See item
   0c: it is a month behind prod and `check_dev_merge.sh` would
   overwrite prod with it. All five mobile fixes are absent there.

0p. **The globe page logs `[error] pt` from MapLibre's minified vendor
   bundle** under headless/software WebGL, alongside "GPU stall due to
   ReadPixels" warnings. It is inside
   `vendor/maplibre-gl/maplibre-gl.js`, reproduces with no XYZO code
   involved, and does not stop the globe rendering. Left alone — editing
   a vendored bundle is how a vendor upgrade becomes impossible.

0q. **`keepPopupOnScreen()` reads `#search-bar`'s resting rect.** If a
   search-suggestion dropdown is open under the bar, a popup can tuck
   behind the dropdown. Horizontal framing is solid; this corner is not.

0r. **Mobile is verified with a Playwright phone profile, not a device.**
   `pw.devices["iPhone 14 Pro"]` gives the right viewport, DPR,
   `hasTouch` and `isMobile`, and it caught all five defects — but it is
   Chromium. **Safari's own touch/tap synthesis, momentum scrolling and
   `env(safe-area-inset-bottom)` have never been checked on hardware.**
   The `-webkit-overflow-scrolling: touch` and safe-area rules are in
   place because the docs say they are needed, not because they were
   seen to work.

0s. **The eight-field magnetic-layer rewrite was in danger of being
   lost — it has landed.** A straggler session was still writing
   `public_html/mag-layer.js` when the crash cleanup began (three
   components → eight fields: D / F / H / I × main / change), and the
   cleanup found it **internally inconsistent in four places** —
   `probeText()`/`sample()`/`isActive()` still read `state.grids` after
   it was renamed to `state.planes`; `refreshRamp()` called a `comp()`
   that no longer existed; the lines export read `COMPONENTS[key].title`,
   a property nothing had; and the header promised two selector rows
   while `mountLegend()` still rendered the old three chips — so it was
   **reverted as abandoned**. It is now **finished and shipped**
   (`23dae47`, with the worker half in `e034e62`): all four defects
   fixed (the loader's unit is the plane via `ensureFieldGrid(key)`,
   `refreshRamp()` reads `fieldKey()`/`fieldDef()`, the export reads
   `FIELDS[key]`, and `mountLegend()` builds both chip rows from
   `COMPONENT_ORDER`/`MODE_ORDER`), the globe side written to match, and
   the contract pinned by 30 new worker tests and 12 new frontend tests.
   **844 frontend / 0 fail, 86 worker mag tests green.** The lesson worth
   keeping: a half-landed refactor is only "abandoned" once somebody has
   asked the person still writing it.

0t. **The globe supports 21 of the flat map's 33 overlays**, so a
   handoff is faithful for what it carries and INCOMPLETE for the rest.
   `view-handoff` passes unknown slugs through untouched (the globe's
   `if (!st) continue` skips them), which is right — a user who ticks
   transport, salinity, the ECCO currents, wave, CAPE, IVT, relief,
   phytoplankton, languages or city names on the flat map and clicks the
   globe arrives with those off. **Since 2026-11-07 the loss is one-way
   only**: the globe declares what it can draw
   (`XYZO_HANDOFF.registerGlobeKeys`) and "Back to the map" puts the
   rest back, so a 2D → 3D → 2D trip returns every overlay the reader
   started with — but nothing tells the 3D reader that three overlays
   (WorldPop population, HWSD soil type, FAO 2026 rivers — see Q-N22)
   were left out rather than broken. Geologic contacts are deliberately
   absent (WMS, documented in `globe.html`'s ABOUT text); the others are
   just unported. Three Playwright tools make the gap visible rather
   than invisible: `scripts/globe_audit.py` enumerates the toggles that
   DO exist and verifies each renders (21/21),
   `scripts/globe_handoff_check.py` round-trips a known view both ways
   (6/6), and `scripts/shared_link_parity.py` round-trips a WHOLE link
   — every overlay and every setting — and buckets what was lost.

**Wildlife network**

0. **312 of the 443 wildlife candidates have no usable feed**, and they
   will stay that way until the publishers offer one. 109 are hostnames
   that do not resolve (the speculative government domains — most of
   them were invented in the 200-source brief and do not exist), 48 are
   behind Cloudflare's bot wall (WWF, Smithsonian Magazine, Sea
   Shepherd, CITES, Ramsar, IUCN's Red List), and the rest publish
   nothing machine-readable. Those publishers can still be read — they
   just cannot be ingested, and **no attempt is made to bypass a bot
   wall**. Re-run `python3 -m worker.wildlife_sources validate
   --retry-failed` to re-probe them.
   The registry keeps every candidate with its derived skip reason, so
   the directory is a record of what was probed, not a list of wishes.

**Data quality**

1. **Duplicate `news_locations` rows** — 2,921 groups / 3,580 redundant
   rows remain (one city can exist as "Abuja", "Abuja, NG", "FCT" and
   "FCT, Nigeria" — four rows, one place). Merging repoints ~220k
   `news_articles` rows, which is hours of IO on a busy disk. The tooling
   is ready: `python3 -m worker.repair_locations --apply --merge`.
2. **Gazetteer false positives** — "delta" → Delta, CA (the word),
   "Wells Fargo" → Fargo, ND, "chũ" → Chũ, VN, "Ho" → Guatemala City.
   They need `cities_text.SKIP_WORDS` entries, like the existing
   fargo/negara/jos ones.
3. **16.4k articles still awaiting placement** after the pile cleanup —
   the fast path drains 10k per cycle, the AI path 60. Was 61k on
   10-24, so the backlog is draining.

**Performance**

4. **Search is slow because it does not use full-text search at all.**
   `/api/pins?q=` and `/search/results` match with **trigram (`%`) /
   `ILIKE` / `similarity()`** — `@ts_query` is never used against
   `news_articles`. That is why the two GIN FTS indexes sat at
   `idx_scan = 0` for the database's entire lifetime and were dropped on
   2026-10-26 (3.4 GB). The slowness is the trigram path, not a missing
   index. Adding a real FTS path would need a `tsv` generated column over
   title+summary (not `body`) plus a GIN index on it.
5. **`news_story_links` is 24 GB / 41.4 M rows** and growing ~10 M rows a
   week. It is the largest table in the database. A `--cleanup` flag
   already exists in `worker/nn_batch_links.py` but **nothing schedules
   it**. Neither it nor `news_articles` has any age-based retention —
   the full design and the three open decisions are in "Database Storage
   Strategy".
6. **The nightly job fails every night.** `xyzo-nightly.service` has been
   timed out at 1 h (raised to 2 h, then to 4 h on 2026-10-26) and is
   killed at exactly `TimeoutStartSec` every time — the audio-fetch step
   alone spans 273 feeds with 30–60 min gaps in the log. Consequence:
   **the 30-day cleanup DELETEs in Step 8 have not run in ~6 weeks**, so
   `news_location_views` has 1.06 M rows older than 30 days. The three
   DELETEs should move to their own oneshot timer (copying the
   `xyzo-retention` pattern) instead of sitting behind a 4-hour job.
7. **A >90% disk is detected but nobody is told.**
   `system-health-check.sh` flags `DISK CRITICAL` correctly — its
   `send_alert()` is an `echo` into a log file. There is no page, no
   email, no webhook.

**Operations**

8. **No scheduled rebuild of `news_source_geography`** — the profiles the
   placement gate reads are rebuilt by hand
   (`python3 -m worker.source_profiles --all --days 30`).
9. **`worker.api_watchdog`'s restart budget** — it calls
   `systemctl restart` with a 30 s timeout, while the unit's start takes
   ~2.5 s now; the timeout is only a guard against a wedged systemd.
10. **Nothing watches for transactions left open.** On 2026-10-26 a
    `worker.run` process was found stuck in `D` (uninterruptible) state
    for 9 h 53 m holding a transaction **idle for 9 hours**. A held
    transaction pins PostgreSQL's `xmin` horizon, which stops autovacuum
    reclaiming dead tuples **database-wide** — a plausible root cause of
    the bloat that was cleaned up that day, not a one-off.
    `SELECT pid, now()-xact_start FROM pg_stat_activity
    WHERE state='idle in transaction'` is worth adding to
    `health_monitor`.

**Measurement**

11. **Timing checks are unreliable while the box is busy.** The same
    `/api/pins/map` query that returns in **1.36 s** when idle has been
    measured at **36 s** — and `/api/pins/stats` has swung **2 ms → 15 s**
    between consecutive runs — because several AI sessions plus the
    fetchers push the load average to 20–25 on 16 cores with ~30 % iowait.
    If `scripts/validate-api.sh` reports `SLOW:` or an SLA miss, check
    `uptime` **first** and re-run before believing it. A real regression
    is reproducible when idle; a starved box is not.
    (`PostgresError: canceling statement due to statement timeout` in
    `journalctl -u xyzo-api` is the same symptom, not a bug.)

Q-N39. **THE OVERLAY STACK IS THE FRAME BUDGET ON A NON-ACCELERATED
   BROWSER, AND NOTHING IN THE PAGE FIXES IT.** (2026-11-14, the wind
   session.) Measured on the owner's fifteen-overlay link with
   `scripts/wind_perf_audit.py`: the frame cost grows ~**17 ms per
   overlay layer** (1 overlay 50 ms → 4 → 100 → 8 → 183 → 12 → 234), and
   hiding the other **35** Leaflet panes takes the identical page from
   **267 ms → 50 ms** — the compositor re-stacks a deep pile of
   full-screen layers whenever one animated layer goes dirty. Free on a
   GPU; the whole frame budget when every pixel is painted by the CPU
   (headless Chromium, Firefox on a blocklisted/driverless driver, a
   VM). This corroborates Q-N23 from the other direction — *"8 fps with
   the wind ON and 8 fps with it OFF, 49 fps with the other fourteen
   overlays hidden"* — and Q-N23's conclusion stands: the frame budget
   belongs to the rest of the link.
   **THREE CSS CANDIDATES, ALL REJECTED BY MEASUREMENT:**
   `will-change: transform` and `translate3d(0,0,0)` on every pane
   changed nothing (3.7 → 3.7 fps); `contain: paint` reported **3.7 →
   23.8 fps** and was a **lie** — all 36 Leaflet panes are **0 × 0**, so
   containment clipped the entire map blank (mean luminance 125 → 214,
   15.6 % of pixels moved), and with the panes sized first (`inset: 0`)
   the gain disappeared entirely (5.8 fps). **A speedup that draws
   nothing is not a speedup**; a pixel diff is the only thing that
   caught it, which is the rule: any future "make it faster" change to
   a renderer needs a screenshot/geometry check beside the fps number.
   *Impact:* an animated overlay over 12–15 overlays runs at 4–6 fps in
   that regime. The dot **pace** is fixed (the dt cap, 2026-11-14), so
   the wind now moves at correct speed — but it moves in visible steps.
   *Remedy if it ever matters:* fewer overlays while something animates
   (the legend's tip now says exactly that), a GPU/working layer
   acceleration, or shrinking the animated canvas's **screen** area as a
   quality fallback (untested, and it costs sharpness). Shedding more
   DOTS is not the answer — measured, density 25 % → 400 % moves the
   frame by tens of milliseconds while the stack moves it by hundreds.
   **Not fixed.**

Q-N40. **CHROMIUM'S BOOT ON THE HEAVY LINK BLOCKS THE MAIN THREAD FOR
   SECONDS — measured, not yet attributed.** (2026-11-14.) The wind-off
   control on the same link reads **5.1–6.0 fps with 8 long tasks, 57 %
   of the window inside them and a worst frame of 3,666 ms** (a density
   sweep caught a **3,133 ms** frame at t≈30 s); Firefox in the same
   runs reports **0 long tasks**, because Firefox has no `longtask`
   entry type at all — so a "Chromium looks worse" reading from that
   column alone is comparing a measurement with its own absence. The
   task has not been attributed: the candidates are the grid decodes and
   canvas bakes (lightning 2.8 MB, population), the `step=0.25` isobar
   parse (2.3 MB of JSON) and the first pin render. *Remedy if it
   matters:* `PerformanceObserver` with `longanimationframe` (Chromium)
   names the blocking script directly — not built; `client_perf` now
   records `long_tasks`, `long_busy_pct` and `frame_worst_ms` per
   session so real readers can say how common it is first.
   **Not diagnosed.**

Q-N42. **A FAILED `/api/` REQUEST IS REPORTED TO THE READER AS A BROKEN
    SERVICE WORKER — two wordings, both of which are the NETWORK.**
    (2026-11-14.) Owner report:
    `Failed to load 'https://xyzo.org/api/pins/map?bbox=…&limit=2000…'.`
    `A ServiceWorker intercepted the request and encountered an`
    `unexpected error. sw.js:491:11`. The line always quotes
    `event.respondWith(…)` — the worker's own call site — so it says
    nothing about WHAT failed. **Measured with a new gate,
    `scripts/sw_console_audit.py`** (Playwright/Firefox, the shipped
    `sw.js` served from a local origin whose `/api/*` we control, and
    **interception proven before every scenario**), Firefox uses two
    different sentences at that one line, and the sentence IS the
    diagnosis:

    - **"A ServiceWorker passed an Error Response to
      FetchEvent.respondWith(). This typically means the ServiceWorker
      performed an invalid fetch() call"** → the request **never
      completed**: `networkFirst()` had no cached copy and answered
      `Response.error()`.
    - **"A ServiceWorker intercepted the request and encountered an
      unexpected error."** ← *the reported one* → the response
      **started and its BODY died mid-transfer** — headers promising
      100,000 bytes with 5,000 delivered, i.e. their **630 KB**
      `limit=2000` answer cut short.

    Both reproduce deterministically in the audit, both give the page a
    `TypeError`, and the page then runs its own retry →
    `restoreCachedPinsOrError()` banner. **The worker is not broken;
    the wording ("invalid fetch() call") is Firefox's, not ours, and it
    cannot be edited.** The second case cannot be prevented from inside
    `sw.js`: the body fails *after* `respondWith` has resolved, and
    buffering 0.6–2 MB to check it would destroy the NDJSON stream the
    renderer reads progressively.

    **WHAT WAS ADDED** is a guard at the call site:
    `networkFirst(…).catch(() => networkError())` — a promise rejecting
    inside `respondWith` would be a hole in the function's own
    try/catch list (or one added by a future edit), and the guard turns
    it into the same `TypeError` the failure path already returns: it
    changes the CONSOLE, not the CONTRACT.

    **THE TRAP IS IN THE MEASUREMENT, AND IT VOIDED FOUR RUNS:**
    `navigator.serviceWorker.controller` being truthy does **not** mean
    the next `fetch()` goes through the worker. Measured on Playwright
    Firefox 153, `wait_for_function` reports `active + controlling` and
    the very next request still lands 404 at the origin — so four
    scenarios were read as "console clean" when nothing had been
    intercepted at all. The audit answers a path the origin 404s and
    only the worker can serve (`/api/__audit_probe`) and **polls until
    the worker engages**. A console-clean result with no interception
    proof is not a result.

Q-N43. **Firefox warns about the `zoom` property the text-size control
    is built on — and a CSS warning cannot be suppressed from
    JavaScript.** (2026-11-14.) Owner report: *"This page uses the non
    standard property "zoom". Consider using calc() … or using
    "transform" along with "transform-origin: 0 0""*.

    - **It comes from ONE declaration** — `styles.css:8467`,
      `zoom: var(--ui-zoom)` on the nine text-size targets (the
      A / A+ / A++ control). It is the only `zoom:` property in our own
      CSS; `vendor/leaflet/leaflet.css` carries `-ms-zoom`, an IE
      prefix Firefox ignores.
    - **It is a WARNING, not an error, and the property works**:
      measured in Firefox 153, `zoom: 1.5` scales an inline block
      **151.2 px → 226.8 px**.
    - **It cannot be silenced from the page.** `console-guard.js`
      intercepts `console.*`; a CSS parse warning is emitted by the
      renderer and never reaches any JS API. The only way to remove the
      warning is to remove the property.
    - **Removing `zoom` is not cosmetic.** `zoom` is layout-affecting
      and `transform: scale()` is not — the control is built on that
      difference (zooming `.live-panel` itself would push it past the
      viewport bottom, and the popup's `max-width` is divided by
      `var(--ui-zoom)` for Leaflet's own measurement).
    - **Not fixed**: a devtools-only warning that names a working,
      deliberate property is cheaper to keep than a legibility
      regression is to risk. If it ever must go, the honest candidates
      are `@supports (zoom: 1)` around the rule, or per-target
      font-size scaling — neither verifiable here, see the trap.
    - **TRAP: Playwright's Firefox does not forward CSS warnings to
      `page.on("console")` at all** — a deliberately unknown property
      (`totally-not-a-property: 3`) also produced nothing — so "no
      warning in the harness" is not evidence that Firefox has stopped
      warning. The user's browser is the only instrument for this one.

---

0u. **`app.js` has 8 bytes of headroom** — 849,992 against the 850,000
   runaway ceiling asserted by `code-splitting.bun.test.js`. The ceiling
   existed for a reason and the next person to add a line will trip it
   with an error that looks unrelated to their change. Registration of
   generic overlay modules was moved OUT (`generic-layers.js` holds the
   module names; app.js reads one identifier instead of an inline array)
   precisely so adding another layer of this shape costs two bytes
   rather than thirty-six — but the headroom itself is still nearly
   gone. **When it runs out, extract a chunk with `loadChunk()`** (the
   pattern `flag-quality.js` / `ai-story-chat.js` already use); do not
   raise the ceiling and do not delete comments to make room — the
   comments are the record of why. The most obvious candidate is the
   `LAYER_SLUGS` / `REVERSE_LAYER_SLUGS` tables: ~8 KB of pure data that
   a blob loaded before app.js would both free and make future slug
   entries free.

## Contributing

### Rules

1. **Test before deploy** — run `bash scripts/validate-api.sh`
   (it must end with `ALL CHECKS PASSED — safe to deploy`)
2. **Don't break production** — if xyzo.org is up, be careful
3. **Document changes** — add session notes under `docs/`
4. **Bump the frontend build token** — `bash scripts/bump_frontend.sh`
   after touching anything in `public_html/`
5. **Restart the workers after changing Python** —
   `sudo systemctl restart xyzo-fast-fetcher xyzo-fetcher` (a running
   cycle keeps the old code in memory)
6. **Ask for help** — community is friendly

### What to Work On

| Area | Who | How |
|------|-----|-----|
| Bug fixes | Anyone | File issue, submit PR |
| Python pipeline | Backend dev | `worker/*.py` |
| Frontend | JS dev | `public_html/app.js` |
| NLP/ML | ML dev | `worker/extract*.py` |
| Placement quality | Backend dev | `worker/auto_categorize.py`, `worker/source_profiles.py`, `worker/place_disambiguation.py` |
| Data repair | Anyone | `worker/fix_source_pileups.py`, `worker/normalize_location_countries.py`, `worker/repair_locations.py` (dry-run first!) |
| API performance | Backend dev | `api/src/routes/*.ts` — check `pg_stat_statements` before and after |
| Community UI | Frontend dev | Admin review interface for `mod_status=rejected/uncertain` community submissions |
| Documentation | Anyone | Edit README, add to `docs/` |

---

## Questions?

- **Issues:** Open on GitHub
- **Docs:** Check `docs/` folder
- **Strategy:** Read `docs/XYZO_AI_MASTER_PLAN.md`
- **Join:** `curl -sSL https://xyzo.org/install-collab.sh | bash`

---

## Vision

```
TODAY:     See what's happening where
    ↓
TOMORROW:  Understand why it's happening
    ↓
FUTURE:    Know what you can do about it
    ↓
EVENTUAL:  Track whether your actions helped
```

Xyzo isn't just a news aggregator. It's a **global problem-solving intelligence system**.

The world's problems are big. But they're not unsolvable.

**That's what we're building.**

---

**The world has 650,000+ stories to tell today.**

**Help us listen.** 🌍🧠
