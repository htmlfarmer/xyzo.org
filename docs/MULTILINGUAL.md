# Multilingual Capabilities

Xyzo processes news in 55+ languages across 175 countries. This document covers what's implemented, how it works, and what's planned.

---

## Current Capabilities

### 1. Language Detection (`worker/lang_detect.py`)

**What it does:** Detects the language of article text before city matching.

**Implementation:**
- `langdetect` library (pure Python, 53 languages) for Latin-script languages
- Script-based fallback for non-Latin scripts (Arabic, CJK, Devanagari, etc.)
- Arabic-script disambiguation: Arabic vs Persian vs Urdu using character frequency

**Coverage:**
- 783,451 / 824,220 articles (95%) have `detected_lang`
- Top languages: English (342K), Spanish (100K), Portuguese (41K), Croatian (37K), German (31K)

**Cost:** CPU-only, ~0.5ms per article

### 2. Multilingual City Index (`worker/cities_text.py`)

**What it does:** Matches city names in their native languages (not just English).

**Implementation:**
- `city_names` table: 106,492 entries across 84 languages
- In-memory index with O(1) lookup per language
- Cities with 100K+ population indexed
- Multi-word phrase matching (longest-first for disambiguation)

**Coverage by language:**

| Language | City Names | Example |
|----------|------------|---------|
| Chinese (zh) | 4,202 | 北京 → Beijing |
| Japanese (ja) | 3,679 | 東京 → Tokyo |
| Russian (ru) | 4,192 | Москва → Moscow |
| Arabic (ar) | 2,877 | دبي → Dubai |
| Korean (ko) | 2,704 | 서울 → Seoul |
| Hindi (hi) | 1,625 | दिल्ली → Delhi |
| Finnish (fi) | 1,534 | Oulu |
| French (fr) | 2,759 | Paris |
| German (de) | 3,112 | München → Munich |
| Spanish (es) | 2,553 | México |

**Cost:** CPU-only, loaded once into memory (~50MB)

### 3. Language-Aware City Matching (NEW)

**What it does:** Passes `detected_lang` to city matching so CJK/Arabic/etc. city names resolve correctly.

**Implementation:**
- `stats(text, lang=detected_lang)` - now accepts optional lang parameter
- `find_cities_in_text()` searches native-language index first, falls back to English

**Results:**
- Japanese: `東京は日本の首都です` → Tokyo, JP ✅
- Chinese: `北京是中国的首都` → Beijing, CN ✅
- English: `Seoul is the capital of South Korea` → Seoul, KR ✅

**Cost:** CPU-only, same as before

### 4. Cross-Country Validation

**What it does:** Rejects city matches where detected city country ≠ source country AND title mentions a third country.

**Example caught:** Korean source about China → wrongly placed in Germany (both mentioned in title) → rejected

**Cost:** CPU-only, simple string matching

### 5. Cross-Language Story Linking (`worker/story_linker.py`)

**What it does:** Links articles in different languages about the same event.

**Implementation:**
- `cross_lang_bonus = 0.10` when articles have different `detected_lang`
- Boosts link strength for cross-language same-event detection

---

## Known Limitations

### Finnish City Inflection

**Problem:** Finnish uses grammatical cases. "Oulu" (nominative) vs "Oulun" (genitive) vs "Kuopio" vs "Kuopion"

**Impact:** 131+ articles mention Finnish cities but land at Helsinki (source fallback)

**Solution options (low cost):**
1. Add common inflected forms table for Finnish (30-50 most common cities × 5 cases each)
2. Use simple suffix stripping: `oulu` stem + `n` genitive → match `Oulu`

### Language Detection Gaps

**Languages with low coverage:**
- Yoruba (yo): 47 cities
- Lao (lo): 13 cities
- Turkmen (tk): 55 cities
- Swahili (sw): 1,214 cities but few sources

**Cost:** Adding more cities to `city_names` is just SQL inserts

---

## Fast/Low-Cost Enhancements

### Priority 1: Finnish Inflection Table

**What:** Add common Finnish city inflections to `city_names` or use suffix stripping.

**Cost:** ~2 hours dev, no GPU, no new dependencies

**Example:**
```sql
INSERT INTO city_names (city_id, lang, name) VALUES
  ((SELECT id FROM world_cities WHERE name = 'Oulu'), 'fi', 'Oulun'),
  ((SELECT id FROM world_cities WHERE name = 'Oulu'), 'fi', 'Ouluun'),
  ((SELECT id FROM world_cities WHERE name = 'Kuopio'), 'fi', 'Kuopion');
```

### Priority 2: Transliteration Fallback

**What:** When city not found in article's language, try transliterating to English.

**Example:** Russian article mentions `Москва` → transliterate to `Moskva` → match `Moscow`

**Cost:** CPU-only, use `transliterate` library or simple character mapping

### Priority 3: Entity→City Location Hints

**What:** Link known entities to their cities (e.g., `Louvre` → Paris, `Kremlin` → Moscow)

**Implementation:**
- Add `entity_locations` table: entity_name → city_id
- Populate from Wikidata (organizations headquartered in cities)
- Match in `find_cities_in_text()` before entity search

**Cost:** SQL + simple lookup, no GPU

### Priority 4: Turkish/Arabic Diacritics Normalization

**What:** Remove diacritics when matching (e.g., `القاهرة` = `القاهره` = `Cairo`)

**Cost:** Simple string normalization, CPU-only

---

## Medium-Cost Enhancements

### Multilingual Entity Embeddings

**What:** Use sentence-transformers multilingual model for semantic entity matching.

**Example:** "Prénom" (French) and "First name" (English) semantically similar but not identical.

**Cost:** GPU recommended, ~100ms per article

**Alternative (cheaper):** Use word frequency vectors per language

### Cross-Language NEL (Named Entity Linking)

**What:** Link entities across languages to same Wikidata QID.

**Example:** `Emmanuel Macron` (EN) = `Эмманюэль Макрон` (RU) = `Emmanuel Macron` (FR) → Q7744

**Cost:** Would need Wikipedia multilingual index or translation API

---

## Architecture

```
Article Ingested
       │
       ▼
┌──────────────────┐
│ lang_detect.py   │ → detected_lang (en, zh, ar, fi, etc.)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ cities_text.py   │ ← lang=detected_lang now passed!
│ _INDEX.by_lang   │ → Native script city matching
│ (84 languages)   │   (东京 → Tokyo, not "NOT FOUND")
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ auto_categorize  │ → cross-country validation
│ _decide()       │   rejects wrong-country matches
└──────────────────┘
```

---

## Testing

```bash
# Test Finnish inflection
cd /var/www/vhosts/xyzo.org
XYZO_DB_DSN="postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo" python3 -c "
from worker.cities_text import stats

# Without lang hint
r = stats('Oulun tiedetään olevan Pohjois-Pohjanmaan kohtauspiste')
print('Without lang:', r.get('primary'))

# With lang hint (currently not working for Finnish morphology)
r = stats('Oulun tiedetään olevan Pohjois-Pohjanmaan kohtauspiste', lang='fi')
print('With fi hint:', r.get('primary'))
"

# Test CJK matching
python3 -c "
from worker.cities_text import stats

# Japanese
r = stats('東京は日本の首都です', lang='ja')
print('Japanese:', r.get('primary'))

# Chinese
r = stats('北京是中国的首都', lang='zh')
print('Chinese:', r.get('primary'))
"
```

---

## Database Schema

```sql
-- Language detection on articles
ALTER TABLE news_articles ADD COLUMN detected_lang VARCHAR(10);

-- City names in native languages (84 languages)
CREATE TABLE city_names (
    city_id INTEGER REFERENCES world_cities(id),
    lang VARCHAR(10),
    name TEXT,
    name_ascii TEXT,
    PRIMARY KEY (city_id, lang, name)
);

-- Entity → city location hints (proposed)
CREATE TABLE entity_locations (
    entity_name TEXT,
    city_id INTEGER REFERENCES world_cities(id),
    country_code VARCHAR(2),
    PRIMARY KEY (entity_name, country_code)
);
```
