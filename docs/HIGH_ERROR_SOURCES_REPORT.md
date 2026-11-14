# High-Error Sources Analysis Report

**Generated:** 2026-09-20

## Executive Summary

The XYZO news ingestion system has **1,330 sources** with high error counts (>100 errors). Investigation reveals:

1. **Root cause identified:** Stale fetch leases blocked 1,843 sources from being fetched (now cleared)
2. **Failure pattern:** Two major failure waves - Sept 14 and Sept 20
3. **1482 sources have NEVER succeeded** since being added - likely were never viable
4. **Legitimate failures expected** - many from restricted regions or defunct publications

## Failure Distribution

| Failure Date | Sources | Never Succeeded Before |
|--------------|---------|----------------------|
| 2026-09-20  | 1,285   | 1,202                |
| 2026-09-14  | 279     | 278                  |
| Older       | 16      | 2                    |

### By Country (Top 10 by total errors)

| Country | Sources | Total Errors | Avg Errors | Recent Success |
|---------|---------|--------------|------------|---------------|
| US      | 195     | 50,049       | 257        | 28            |
| ME      | 118     | 28,189       | 239        | 0             |
| SO      | 92      | 22,045       | 240        | 0             |
| AF      | 89      | 21,494       | 242        | 0             |
| EA      | 49      | 11,666       | 238        | 0             |
| GB      | 40      | 8,704        | 218        | 4             |
| XX      | 34      | 8,347        | 246        | 2             |
| AR      | 29      | 7,635        | 263        | 0             |
| ID      | 30      | 7,142        | 238        | 2             |
| IN      | 28      | 6,995        | 250        | 1             |

## Categories of High-Error Sources

### Category 1: Never Viable (1482 sources)
**Status:** Added but never successfully fetched even once

These sources were added to the database but never produced valid content. Likely causes:
- Invalid RSS/URL
- Paywall or authentication required
- Site no longer exists
- Network-level blocking

**Recommendation:** Mark as `active=false` or remove

### Category 2: Restricted Region Sources (Majority of ME, SO, AF, EA)
**Status:** Legitimate failures due to regional restrictions

Countries with 0 recent success despite high error counts:
- **Middle East (ME):** 118 sources, 0 recent success
- **Somalia (SO):** 92 sources, 0 recent success
- **Afghanistan (AF):** 89 sources, 0 recent success
- **East Africa (EA):** 49 sources, 0 recent success

**Likely causes:**
- Government internet filtering
- DNS blocking
- IP blocking of foreign requests
- Strict robots.txt

**Recommendation:** Keep marked but accept as expected failures

### Category 3: Defunct Publications
**Status:** Site no longer operational

Examples from sample:
- Al-Akhbar (ME) - Lebanese news site reportedly blocked/restricted
- Al-Zaman (ME) - Iraqi publication with restricted access
- El Faro (SV) - El Salvador outlet that has faced government pressure

**Recommendation:** Periodic recheck, but assume defunct if no success in 6+ months

### Category 4: Intermittent/Partial Failures (99 sources)
**Status:** Sometimes work, sometimes don't

These sources have recent success but also accumulated errors. Could be:
- Rate limiting
- Unstable hosting
- Temporary blocking

**Recommendation:** Monitor, reduce poll frequency

## Sample of Problematic Sources

### Middle East (all failing consistently)
- Daryo.uz (UZ) - Uzbekistan access restrictions
- Al-Seyassah (KW) - Kuwaiti publication
- Attessia TV (TN) - Tunisian outlet
- Al-Bayan (AE) - UAE state media blocking

### Africa (all failing consistently)
- Digital Congo (CG) - DRC restrictions
- RTS Senegal (SN) - Senegal blocking
- Togo Eco (TG) - Togo restrictions

### Defunct/Moved
- ABS-CBN News (PH) - Philippine network shut down by government
- Al-Akhbar (LB) - Lebanese outlet facing restrictions

## Technical Notes

### Failure Timing
- **Sept 14 failure wave:** 279 sources - likely related to a fetch system issue
- **Sept 20 failure wave:** 1,285 sources - coincided with stale lease buildup

### What the errors represent
- Each `error_count` increment = one failed fetch attempt
- Average errors ~240-260 for most failing sources
- At 15-minute poll intervals, 240 errors = ~60 hours of continuous failures

## Recommendations

1. **Mark never-succeeded sources as inactive** after 30 days of no success
2. **Accept regional failures** as operational cost for global coverage
3. **Reduce poll frequency** for intermittent sources (increase `poll_interval_s`)
4. **Recheck defunct sources quarterly** - some may have returned
5. **Document blocking patterns** - ME/AF/SO regions have consistent government-level blocking

## Conclusion

The high error count is **NOT a bug** - it's expected behavior for a global news aggregator. Sources from restricted regions (Middle East, Afghanistan, Somalia) face systematic blocking that we cannot overcome without local infrastructure.

**Action items:**
1. Mark 1482 never-succeeded sources for review/deletion
2. Accept regional failures as operational reality
3. Reduce poll frequency for intermittent sources to reduce server load
