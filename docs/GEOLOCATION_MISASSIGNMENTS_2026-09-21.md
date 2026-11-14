# Geolocation Misassignment Fixes — Sep 21, 2026

## Problem

~15,000+ articles were incorrectly geolocated due to several systemic issues:

### Categories of Misassignment

| Category | Example | Stories | Root Cause |
|---|---|---|---|
| Common word = city name | Fargo (Wells Fargo bank), Negara ("country" in Indonesian), Victoria (common name), El Paso ("the step" in Spanish) | 3889+1409+1509+1606 | `cities_text` picks highest-pop match for any word hit |
| Publication name = location | Silicon Republic (IE pub), 36Kr Global (CN pub), WXYZ Detroit (TV station) | 1519+1503+2049 | Source name leaks into location_text |
| Country code confusion | Vancouver, CA geocoded to Toronto (CA=Canada vs CA=California) | 1413 | Nominatim ambiguity on 2-letter codes |
| City name wrong country | Valencia CF/football → Valencia, VE instead of ES | 816 | No ES context triggers VE (higher pop) |
| Subword matching | "Jos" matching inside Croatian words | 3462 | Regex/tokenizer hits substrings |

## Fixes Applied

### 1. place_disambiguation.py — New Watchlist Entries

Added 7 new entries to `_RAW_ENTRIES`:

- **valencia** — Spain (La Liga, floods, SailGP) vs Venezuela vs California. Reject patterns for football/sailing/flood context.
- **fargo** — North Dakota vs "Wells Fargo" bank. Reject Wells Fargo conference/financial context.
- **negara** — Bali city vs Indonesian word for "country/state". Reject common Indonesian usage.
- **victoria** — Multiple (HK, BC, Australia). Reject person names, brand names, landmarks.
- **el paso** — Texas vs Spanish "the step/pass". Reject generic Spanish usage.
- **jos** — Nigeria vs Croatian/Slavic substrings (Projekt, koga).
- Note: Wollongong not added (unambiguous, but has duplicate location IDs inflating counts).

### 2. cities_text.py — SKIP_WORDS Expansion

Added common words that collide with city names:
- `fargo` — Wells Fargo bank
- `negara` — Indonesian "country/state"
- `jos` — Croatian substrings

### 3. auto_categorize.py — Cross-Country Validation in `_source_fallback()`

**Bug fixed:** `_source_fallback()` had NO cross-country validation, while `_decide()` had Rule B. Now `_source_fallback()` applies the same check:
- If detected city's country ≠ source country AND city country not mentioned in text → reject

Also fixed: `full_stats.get("all")` → `full_stats.get("cities")` (wrong key name).

### 4. extract.py — Stronger Cross-Country Validation

**Old check:** `if loc_country not in mentioned AND src_country in mentioned`
**New check:** `if loc_country not in mentioned`

The old check required source country to be explicitly mentioned in text, which is often not the case for short articles. The new check simply rejects when city country isn't mentioned.

## How to Find More Cases

### Statistical Anomaly Detection

Query to find cities with suspiciously high story counts relative to population:

```sql
SELECT 
  nl.place_name,
  nl.country,
  COUNT(*) as stories_30d,
  (SELECT COUNT(DISTINCT ns.country) 
   FROM news_articles na2 
   JOIN news_sources ns ON na2.source_id = ns.id
   WHERE na2.location_id = nl.id AND na2.status='extracted') as source_countries,
  (SELECT mode() WITHIN GROUP (ORDER BY ns2.country)
   FROM news_articles na3 
   JOIN news_sources ns2 ON na3.source_id = ns2.id
   WHERE na3.location_id = nl.id AND na3.status='extracted') as primary_source_country
FROM news_articles na
JOIN news_locations nl ON na.location_id = nl.id
WHERE na.status = 'extracted'
  AND na.published_at > now() - interval '30 days'
GROUP BY nl.id, nl.place_name, nl.country, nl.lat, nl.lng
HAVING COUNT(*) > 100
ORDER BY stories_30d DESC;
```

### Red Flags to Look For

1. **Primary source country ≠ city country** — e.g., Jos, NG has primary source RS (Serbia)
2. **Low source country diversity** — e.g., Fargo, US with only 4 source countries
3. **Common English words as city names** — Fargo, Victoria, El Paso, etc.
4. **Publication names as locations** — Silicon Republic, 36Kr, WXYZ Detroit
5. **Small cities with huge story counts** — Negara, ID (pop ~40k) with 1409 stories

## Known Issues (Not Fixed Tonight)

1. **Publication name leak** — Source names like "Silicon Republic", "36Kr Global", "WXYZ Detroit" leak into location_text via the source's `geocoded_location` field. Needs source-location validation against world_cities.

2. **Duplicate location IDs** — Wollongong has 5 location IDs (370, 379, 6250, 6253, 6254), inflating story counts. Needs DB cleanup.

3. **Vancouver, CA geocoding** — Nominatim confuses CA (Canada) with CA (California). Needs explicit country code handling.

4. **Valencia, VE still has 781 articles** — New articles will be blocked by the watchlist, but existing misassigned articles need a cleanup job.

## Test Results

- `worker/tests/test_place_disambiguation.py`: ✅ 215/215 passed (including new entries)
- Manual verification: ✅ 13/13 new disambiguation tests passed
- cities_text SKIP_WORDS: ✅ Fargo/Negara/Jos no longer match as cities

## Files Changed

- `worker/place_disambiguation.py` — Added 7 new watchlist entries (valencia, fargo, negara, victoria, el paso, jos)
- `worker/cities_text.py` — Added fargo, negara, jos to SKIP_WORDS
- `worker/auto_categorize.py` — Added cross-country validation in `_source_fallback()`, fixed `full_stats.get("all")` → `full_stats.get("cities")`
- `worker/extract.py` — Strengthened cross-country validation (removed src_country requirement)
