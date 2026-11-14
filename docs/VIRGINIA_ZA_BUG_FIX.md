# Virginia, ZA Misplacement Bug Report

**Date:** 2026-09-20
**Status:** FIXED

## Problem

Articles about **Virginia, USA** were being geolocated to **Virginia, ZA (South Africa)** at coordinates `-28.10391, 26.86593`.

### Examples of mislocated articles:
- "Northern Virginia business owner faces civil rights lawsuit - FOX 5 DC"
- "West Virginia American Water Announces $275,000 Water Infrastructure Project"
- "Amy Griggs of Tysons Trial Law Marks 13th Consecutive Year on Virginia Super Lawyers List"
- "Virginia Beach residents protest..."

### Root Cause

1. The `cities_text.find_cities_in_text()` function was matching "Virginia" in article text to the first "Virginia" in the database, which happens to be **Virginia, ZA** (South Africa - population ~122k)

2. The `place_disambiguation.py` did not have a rule for "Virginia" to handle this case

3. The disambiguation logic was accepting "Virginia, ZA" as "qualified" (because it has a comma) without checking if the context supported South Africa vs USA

## Fix Applied

### 1. Updated place_disambiguation.py

Added disambiguation rule for "Virginia":

```python
"virginia": {
    "label": "Virginia (ZA needs context)",
    "reject_patterns": [
        # If context mentions US locations, reject
        r"\bnorthern\s+virginia\b",
        r"\bvirginia\s+beach\b",
        r"\bvirginia\s+tech\b",
        r"\bwest\s+virginia\b",
        r"\brichmond\s+virginia\b",
        r"\barlington\s+virginia\b",
        r"\balexandria\s+virginia\b",
        r"\btysons\b",
        r"\bmclean\b",
        # ... more US location patterns
    ],
    "patterns": [
        # Only keep if there's clear SA context
        r"\bvirginia,\s*za\b",
        r"\bfree\s+state\b",
        r"\bsouth\s+africa\b",
    ],
}
```

### 2. Fixed disambiguation logic

Changed the logic so that even "qualified" locations (with comma) are checked against the watchlist patterns before acceptance.

**Before:** Qualified locations were immediately accepted without checking watchlist
**After:** Watchlist patterns are checked first; qualified locations are only accepted if context matches

### 3. Fixed existing mislocated articles

- **165 articles** cleared from Virginia, ZA:
  - 24 articles with clear US context (Northern Virginia, West Virginia, Tysons, etc.)
  - 141 articles from US sources

### 4. Remaining Virginia, ZA articles

**179 articles** still have Virginia, ZA location_text:
- Mostly from non-US sources (BR=68, AR=29, IN=10, etc.)
- Many are about Brazilian celebrity "Virginia Fonseca" (people named Virginia, not places)
- Some may legitimately be about Virginia, ZA (South Africa town)

These were left as-is because distinguishing between:
- Virginia, ZA (South Africa place)
- Virginia (person's name)
- Virginia, USA (incorrectly classified)

...would require reading each article, which is not scalable.

## Prevention (Sep 20 Fix)

The Sep 20 fix ensures NEW articles will be correctly disambiguated:
- Articles with US context → location rejected → will be re-processed or marked unlocated
- Articles with SA context → location accepted → correctly placed in South Africa

---

## Further Improvements (Sep 21)

### Source Country Prior

On Sep 21, we added **source_country prior** to disambiguation. This means:

**Problem:** Articles from US sources mentioning "Virginia" with NO context were being rejected entirely. But US sources about Virginia, USA are legitimate!

**Solution:** Added `_try_source_country_prior()` that uses the source's country as a prior:
- If source is from US and "Virginia" is mentioned without context, accept Virginia, USA
- If source is from ZA and "Virginia" is mentioned without context, accept Virginia, ZA
- If context keywords for a DIFFERENT country are present, those win

**Coverage:** 19 cities with multi-country ambiguity now use source_country prior:
- virginia, alexandria, cordoba, santiago, granada, memphis
- trinidad, merida, lima, sucre, potosi, tucuman
- copiapo, iquique, antofagasta, valparaiso, concepcion, santa cruz, cochabamba

### Comma-less Qualifier Detection

Also added detection for comma-less qualifiers like:
- "City of Springfield" → qualified
- "Springfield IL" → qualified (US state abbrev)
- "Town of Memphis" → qualified

### Files Changed (Sep 21)

1. `worker/place_disambiguation.py` - Added source_country prior, comma-less qualifiers
2. `worker/extract.py` - Pass source_country to disambiguate()
3. `worker/auto_categorize.py` - Pass source_country to disambiguate()
4. `worker/wiki_geo.py` - Pass source_country to disambiguate()
5. `worker/city_anomaly_detector.py` - Pass source_country to disambiguate()
