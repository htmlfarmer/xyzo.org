# XYZO Diagnostic Report
**Date:** September 20, 2026
**Scope:** Panama coverage investigation + system-wide audit

---

## Executive Summary

We investigated why Panama appeared to have poor coverage on XYZO and discovered a **systematic cross-country contamination issue** affecting 33+ news sources globally. This was caused by incorrect `primary_city_id` assignments in the `news_sources` table.

---

## Critical Issue #1: Source Location Misassignment

### Root Cause
Many sources had `primary_city_id` pointing to cities in **different countries** than the source's declared country. This caused articles to be geolocated to wrong countries via source fallback.

### Examples Fixed

| Source | Country | Was Pointing To | Should Be |
|--------|---------|-----------------|-----------|
| Blic.rs | RS (Serbia) | Jos, NG (Nigeria!) | Belgrade, RS |
| Meduza | LV (Latvia) | York, GB | Riga, LV |
| Siasat | IN (India) | Lahore, PK | Delhi, IN |
| Africa News | CG (Congo) | Madrid, ES | Brazzaville, CG |
| Caracas Chronicles | VE (Venezuela) | Washington, US | Caracas, VE |
| Vietnam News | VN | Kumamoto, JP | Hanoi, VN |
| Barbados Today | BB | Manila, PH | Bridgetown, BB |

### Fix Applied
```bash
XYZO_DB_DSN="..." python scripts/fix_primary_city.py --fix
```

**33 sources fixed** with verified correct `primary_city_id` values.

---

## Critical Issue #2: City Extraction Bugs

### Yangchun Bug (Panama)
514+ Panama articles were incorrectly assigned to **Yangchun, China** instead of actual Panama locations.

**Root Cause:** The `cities_text` FDW-based city lookup was returning Chinese cities for Spanish text queries.

**Example Articles:**
- "Desarrollan la XII Conferencia de Directoras de Panamá" → Yangchun, CN
- "UNACHI reduce sobresueldos..." → Yangchun, CN
- "MiBus señala que alza del combustible..." → Yangchun, CN

### Mubi Bug (US Sports)
triblive.com (Pittsburgh Steelers sports) was marked as country=PA (Panama) instead of US.

**Impact:** US sports articles appearing with Panama coordinates.

### Jos Bug (Serbia)
1400+ Serbian articles were assigned to **Jos, Nigeria** due to `primary_city_id` misassignment.

---

## System Health Overview

| Metric | Value | Status |
|--------|-------|--------|
| Total Sources | 4,049 | OK |
| Active Sources | 3,660 | OK |
| High Error Sources (>50 errors) | 1,330 | WARN |
| Cold Sources (0 articles 7d) | 1,541 | WARN |
| Total Articles | 813,068 | OK |
| Articles without location | 236,813 (29%) | WARN |
| Empty titles | 1,428 | WARN |

### Cold Sources by Country (Top 10)
```
US: 129 cold sources
ME: 121
AF: 94
SO: 93
EA: 49
CN: 45
XX: 39
ID: 32
AR: 30
GB: 27
```

---

## Cross-Country Contamination Patterns

### Confirmed Wrong (Fixed)
These sources had articles placed in wrong countries:

1. **RS → NG**: 1,405 Serbian articles in Nigeria (Jos)
2. **SI → DE**: 892 Slovenian articles in Germany (Mönchengladbach)
3. **AR → ES**: 887 Argentine articles in Spain (Madrid)
4. **NP → SY**: 676 Nepal articles in Syria (Azaz)
5. **ID → SD**: 638 Indonesian articles in Sudan (Nyala)
6. **BG → PE**: 528 Bulgarian articles in Peru (Miraflores)
7. **SK → IN**: 523 Slovak articles in India (Salem)

### Legitimate Cross-Border Reporting (Not Fixed)
These are **correct** - sources legitimately reporting on other countries:

- UN News → Gaza (UN covering Palestinian conflict)
- ReliefWeb → Gaza (UN humanitarian coverage)
- Euronews → Kyiv (EU covering Ukraine war)
- AllAfrica → Addis Ababa (Pan-African agency HQ)

---

## Duplicate Articles

| Source Pair | Issue |
|-------------|-------|
| Juegos Suramericanos on 3 PA sources | Same content on multiple Panamanian sources |
| Your Morning Smile | Duplicated across sources |

---

## Pending Issues

### High Priority
1. **Source extraction bugs** - `cities_text.find_cities_in_text()` returning wrong cities for some language/region combinations
2. **Triblive.com misclassification** - marked as PA instead of US

### Medium Priority
1. **Cold sources** - 1,541 sources with no articles in 7 days
2. **High error sources** - 1,330 sources with >50 errors
3. **Pending articles** - 878 articles still in `pending` status

---

## Recommendations

### Immediate (Do Now)
1. Fix triblive.com source country (US, not PA)
2. Investigate `cities_text` city extraction for Spanish/Cyrillic text
3. Run `fix_primary_city.py` periodically to catch new misassignments
4. Add monitoring for cross-country contamination

### Short Term (This Week)
1. Build Source Health Dashboard showing:
   - Articles per source per day
   - Error rates
   - Cross-country contamination alerts
   - Location extraction success rates

2. Add Panama-specific sources:
   - La Estrella de Panamá (currently disabled)
   - Metro Libre (currently disabled)

### Medium Term (This Month)
1. Build Source Discovery system for multilingual sources
2. Implement language-specific NLP pipelines
3. Add coverage gap detection (e.g., Darién, Bocas del Toro missing)

---

## Scripts Created

### `scripts/fix_primary_city.py`
Fixes `primary_city_id` misassignments in news_sources.

```bash
# Dry run - see what would be fixed
XYZO_DB_DSN="..." python scripts/fix_primary_city.py --list

# Actually fix
XYZO_DB_DSN="..." python scripts/fix_primary_city.py --fix

# Fix specific source
XYZO_DB_DSN="..." python scripts/fix_primary_city.py --fix --source-id 1001
```

---

## Test Results

```
tests/test_article_validation.py: 9 passed
tests/test_ai_validate.py: 8 passed
```

All critical tests pass after fixes.

---

## Database Queries for Monitoring

### Check cross-country contamination
```sql
SELECT source_country, location_country, COUNT(*) as cnt
FROM news_articles na
JOIN news_sources ns ON na.source_id = ns.id
LEFT JOIN news_locations nl ON na.location_id = nl.id
WHERE nl.country != ns.country
AND nl.country IS NOT NULL
GROUP BY source_country, location_country
ORDER BY cnt DESC
LIMIT 20;
```

### Find misassigned primary_city_id
```sql
SELECT ns.id, ns.name, ns.country, ns.primary_city_id, wc.name, wc.country_code
FROM news_sources ns
JOIN world_cities wc ON ns.primary_city_id = wc.id
WHERE ns.primary_city_id IS NOT NULL
AND wc.country_code != ns.country
AND ns.active = true;
```

### Check cold sources
```sql
SELECT country, COUNT(*) as cold_count
FROM news_sources ns
LEFT JOIN news_articles na ON ns.id = na.source_id AND na.published_at > NOW() - INTERVAL '7 days'
WHERE ns.active = true AND na.id IS NULL
GROUP BY country
ORDER BY cold_count DESC;
```
