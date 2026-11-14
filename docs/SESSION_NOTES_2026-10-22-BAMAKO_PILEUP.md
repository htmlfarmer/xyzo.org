# Session Notes — 2026-10-22 (late) — "103 Stories in Bamako, ML"

## The report

The map showed a pin in Bamako, Mali with **"103 Stories in Bamako, ML"** in the
location explorer, while the rest of Mali had almost nothing. The number was
larger than a city of Mali's daily output, and every one of the 103 stories in
that list was a **programming blog post**.

## Root cause (three layers)

### 1. A source with the wrong country

`worker/feeds.json` seeds dev.to as a **Malian** source:

```json
{ "name": "DEV Community", "feed_url": "https://dev.to/feed", "country": "ML" }
```

dev.to is a global developer-blog platform with no country at all. When
`auto_categorize._source_fallback()` could not find a city in an article
(dev.to posts are about code — most never name a place), it fell through to
"largest city in the source's country" → **Bamako**. 12,368 articles landed on
one point.

### 2. The same bug, 3× bigger, with a two-letter-code collision

141 pan-Arab sources were tagged `country: "ME"` meaning **"Middle East"**.
`ME` is ISO **Montenegro** — so every one of their stories fell onto
**Podgorica**: **41,106 articles in 30 days**. `ReliefWeb` (`country: "UN"`)
landed on New York (UN HQ). `Asharq al-Awsat` (`country: "GB"`) landed on
"Belfast, GB" — a location row that held *London's* coordinates.

### 3. The fallback was self-reinforcing

`news_source_geography` (the per-source profile used by the fallback) counted
**all** placements, including the ones the fallback itself had made. So the
pinned city became the profile's "top city", and the next cycle pinned even
more articles there. That is how 12.4k dev.to posts grew a 25.9k pile on
**Fargo, ND** (the profile's top city was "Fargo" — the text "Wells Fargo"),
and how "Negara, ID" / "Warren, US" / "Jos, NG" became hotspots.

### Why the number was 103 and not 12,368

`/api/pins/map` samples at most `maxPerLocation` (100) articles per
`location_id` at city zoom, and the city existed as **two** `news_locations`
rows (`Bamako, ML` id 12864 and id 6626) → 100 + 3 = 103. The duplicate rows
also split every city's story count across several pins.

## What was changed

| Area | Change |
|---|---|
| `worker/auto_categorize.py` | New gate `_source_geo_is_country_specific()` — a source may only use a single-city fallback when its own country really is its centre of gravity. Pseudo codes (`UN`, `EU`, `GLOBAL`), `ME`+MENA, no country, and a mis-tagged country (own-country share < 10 % of its own-text articles) are refused → the article is left **unlocated** instead of pinned to a capital. |
| `worker/source_profiles.py` | The geographic profile is now computed from **content placements only** (`auto_categorize_method IS DISTINCT FROM 'source_fallback'`), so the profile measures editorial geography and can no longer be polluted by its own fallback. New column `content_article_count_30d`. |
| `worker/feeds.json` | `DEV Community` country `ML` → `null`; the 28 MENA entries with `country: "ME"` → `null`. |
| `news_sources.country` | 141 MENA sources → `NULL`; dev.to → `NULL`; 9 clearly mis-tagged sources corrected (Malay Mail ID→MY, Sidwaya/Burkina 24 AF→BF, Youm7 AF→EG, Dainik Bhaskar SO→IN, …); 146 sources got a missing `region`. |
| `news_locations.country` | **17,004 rows** normalised from Nominatim's full country names ("United States", "Türkiye", "ایران") to ISO-2. Every cross-country comparison in the pipeline compared apples to oranges before this. |
| `news_locations` labels | 6,368 rows relabelled to the place their **own articles** name (the arbiter is `news_articles.location_text`, not the gazetteer): "Belfast, GB" holding London → "London Metropolitan Area, GB", "Ho, GT" → "Guatemala City, GT", … |
| Pileup cleanup | `worker/fix_source_pileups.py` reset **80,724** source-based placements of mis-tagged sources (Bamako 12.4k → 240, Podgorica 41k → 9k) for re-categorisation from their own text. |
| "Fargo, US" | The profile's top city was *Fargo* (from the text "Wells Fargo") → 25,823 fallback placements pinned there. Reset (`--reset-location "Fargo, US"`); the genuine Fargo, ND stories (127) stay. |
| "Abuja, NG" | Two rows: one on Lagos' coordinates (25k stories whose own `location_text` says Abuja) and one on the real coordinates. Merged onto Abuja — 30,838 stories, one pin, right position. |
| Tests | `worker/tests/test_source_country_gate.py` (11 tests) pins the gate rules; `test_news_source_addition.py` and `test_source_sync_regression.py` updated for country-less regional sources. |

## New tooling

```bash
# audit + repair the "one source owns one capital" pileups
python3 -m worker.fix_source_pileups --dry-run
python3 -m worker.fix_source_pileups --fix-sources --apply   # country metadata
python3 -m worker.fix_source_pileups --apply                 # reset the piles

# normalise news_locations.country to ISO-2
python3 -m worker.normalize_location_countries --dry-run
python3 -m worker.normalize_location_countries --apply

# relabel / move mislabelled location rows (merging duplicates is --merge)
python3 -m worker.repair_locations --dry-run
python3 -m worker.repair_locations --apply
```

## Result

| Place | Before (24 h) | After (24 h) |
|---|---|---|
| Bamako, ML | **103** stories — all dev.to | **6** stories — real Mali news |
| Podgorica, ME | ~1,591 stories — all Middle-East papers | **0** |
| "Belfast, GB" | 11,542 articles, actually in London | relabelled "London Metropolitan Area, GB" |
| Fargo, US | 1,057 stories — all "Wells Fargo" | 0 (the real Fargo, ND keeps its 127) |
| Abuja, NG | 894 stories pinned on Lagos' coordinates | 890 stories, one pin, on Abuja |

The 24-hour top of the map is now Buenos Aires, New York, Jakarta, Zagreb,
New Delhi, Berlin, Istanbul, Mumbai, Abuja, Tehran, São Paulo, Seoul — i.e.
real news cities, with the fake capitals gone.

## Known follow-ups (not done — the box's disk is at 99 %)

1. **Duplicate `news_locations` rows**: 2,921 groups / 3,580 redundant rows
   still exist, plus labels for the same place under different names
   ("Abuja", "Abuja, NG", "FCT", "FCT, Nigeria" — four rows, one city).
   Merging them repoints ~220k `news_articles` rows; on this disk that is
   ~18 rows/s, i.e. hours of IO. `worker/repair_locations.py --merge` does
   it — run it in a quiet window. Until then a city can show several
   adjacent pins and split its story count.
2. **`/api/story-links/stats` > 10 s** and `/api/locations/search` ~11 s —
   pre-existing full-scan problems (the health check times out on them under
   load; the baseline entry for story-links/stats was already dropped on
   Sep 28).
3. **Gazetteer false positives** still create small fake hotspots: "Delta,
   CA" (the word "delta"), "Shaping, CN", "Jinja, UG", "Ray, IR". They need
   `cities_text.SKIP_WORDS` entries like the existing fargo/negara/jos ones.
4. The `location_text` of an article is the arbiter for a location row's
   label, but it is itself produced by the same pipeline — a source-level
   mis-tag still shows up in both.
5. **~103k articles are `status='pending'`** after the pileup reset; the
   fast path drains 10k per cycle, the AI path 60 — the leftovers stay
   pending for a while (that is the designed behaviour for stories that
   name no place).

## Test status

- `worker/tests/`: **675 pass / 24 fail** — the same 24 pre-existing failures
  (ai_client ×2, image_pipeline ×11, labeling, location_id_backfill,
  news_source_addition DatabaseSync ×4, service_events_api ×2,
  source_quality language_primary, video). Baseline was 642/24.
- `public_html/tests/`: 118 pass / 17 fail — all pre-existing (no frontend
  file was touched).
- `scripts/validate-api.sh`: fails only on the graphical E2E UI checks
  (clusters/markers mode toggles, category-filter pill) — no frontend file
  was touched; these are pre-existing.
- `bun run scripts/api-health-check.js`: 9 pass / 0 changed / 1 timeout
  (`locations/search` under load).
