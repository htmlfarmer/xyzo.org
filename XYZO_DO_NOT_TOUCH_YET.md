# XYZO DO NOT TOUCH YET

## Components That Work Well or Are Too Risky to Modify

---

## STABLE COMPONENTS (Do Not Modify Without Strong Evidence)

### 1. Tier-Aware Politeness System
**Files:** `worker/robots.py`, `worker/fetch.py`, `api/migrations/2026-09-07-last-polled-at.sql`
**Why:** Enforced at 3 layers (robots.txt, in-cycle throttle, SQL gate). Any change could violate legal/ethical constraints on government/university sites.
**Risk:** Legal action, reputation damage, crawler bans
**Last verified:** Working correctly (99.7% fetch success)

### 2. AI Circuit Breaker
**Files:** `api/src/ai-breaker.ts`, `worker/ai_client.py`
**Why:** Prevents cascading failures when AI provider is down. 5 failures → 180s cooldown.
**Risk:** System overload, cost explosion, service degradation
**Last verified:** Active and functioning

### 3. ETag-Based Dedup
**Files:** `worker/fetch.py`, `news_fetch_decisions` table
**Why:** Prevents duplicate article ingestion. Breaking this would pollute the database.
**Risk:** Data pollution, duplicate content, wasted resources
**Last verified:** 733K decisions tracked, 0 duplicates detected

### 4. Cross-Country Validation
**Files:** `worker/auto_categorize.py`, `worker/extract.py`
**Why:** Prevents 90%+ of mislocations. Multiple validators at different pipeline stages.
**Risk:** Geographic accuracy degradation, user trust erosion
**Last verified:** 90.9% average geocoding confidence

### 5. Event-Level Dedup
**Files:** `api/src/routes/pins.ts`, `worker/cluster.py`
**Why:** Prevents duplicate markers on map. 1 pin per event, not per article.
**Risk:** UX degradation, confusion, trust erosion
**Last verified:** 50K events from 100K+ articles

---

## FRAGILE COMPONENTS (Modify with Extreme Caution)

### 6. Nominatim Rate Limiting
**Files:** `worker/geocode.py`
**Why:** Public Nominatim caps at 1 req/s. Exceeding this risks IP bans.
**Risk:** Geocoding failure, pipeline stall
**Sensitivity:** Very high — rate limit is hard-coded

### 7. Worker Pool Management
**Files:** `api/src/queue/workerPool.ts`
**Why:** Manages 4 Python subprocesses. Changes could cause resource exhaustion or zombie processes.
**Risk:** Memory leaks, process crashes, API downtime
**Sensitivity:** High — requires understanding of IPC protocol

### 8. AI Extraction Prompts
**Files:** `worker/extract.py`
**Why:** Prompts are carefully tuned for Gemma-4. Changes could break extraction quality.
**Risk:** Extraction accuracy degradation, increased fallback rate
**Sensitivity:** High — requires A/B testing framework

### 9. Category Taxonomy
**Files:** `worker/classify.py`, `worker/nn_classifier.py`
**Why:** 35 categories with complex mapping logic. Changes could break categorization.
**Risk:** Category mismatches, "other" bucket explosion
**Sensitivity:** High — affects all downstream systems

### 10. Source Reliability Scoring
**Files:** `worker/learn.py`
**Why:** Bandit-style scoring affects which sources get polled. Changes could starve good sources.
**Risk:** Data quality degradation, source abandonment
**Sensitivity:** High — affects content pipeline

---

## POORLY UNDERSTOOD COMPONENTS (Investigate Before Changing)

### 11. Neural Network Training Pipeline
**Files:** `worker/nn_train.py`, `worker/nn_features.py`
**Why:** Complex 7-model taxonomy with zero labeled data. Changes could break training.
**Risk:** Model degradation, wasted compute
**Understanding:** Low — only 1 model currently trained

### 12. Story Linking Algorithm
**Files:** `worker/story_linker.py`, `news_story_links` table
**Why:** PageRank-style graph with 97K links. Changes could break event relationships.
**Risk:** Event graph corruption, broken story connections
**Understanding:** Medium — algorithm is documented but not well-tested

### 13. Canvas Renderer
**Files:** `public_html/app.js` (lines 3439-3761)
**Why:** Complex GPU-accelerated rendering with viewport culling. Changes could cause visual glitches.
**Risk:** Map rendering failures, performance degradation
**Understanding:** Medium — well-structured but hard to test

### 14. Search Expansion Logic
**Files:** `api/src/routes/search.ts`
**Why:** Recently added DuckDuckGo fallback. Integration is new and untested at scale.
**Risk:** Search quality degradation, external API dependency
**Understanding:** Low — just implemented

---

## HIGHLY COUPLED COMPONENTS (Changes Ripple Everywhere)

### 15. news_articles Table
**Files:** `api/schema.sql`, all worker modules, all API routes
**Why:** Central table with 33 indexes, referenced by every subsystem. Schema changes affect everything.
**Risk:** Cascade failures, data migration issues
**Coupling:** Extreme — touched by 50+ files

### 16. news_events Table
**Files:** `api/schema-events.sql`, clustering, linking, API routes
**Why:** Event graph hub. Changes affect clustering, linking, and display.
**Risk:** Event graph corruption, broken relationships
**Coupling:** High — 10+ dependent tables

### 17. Frontend app.js
**Files:** `public_html/app.js` (13,823 LOC)
**Why:** Single monolithic script. Any change could break map, search, or live panel.
**Risk:** Complete frontend failure
**Coupling:** Extreme — everything depends on this file

### 18. Database Migrations
**Files:** `api/migrations/*.sql` (30 files)
**Why:** Idempotent but irreversible. Mistakes require manual intervention.
**Risk:** Data loss, schema corruption
**Coupling:** High — affects all queries

---

## COMPONENTS LACKING TESTS (Do Not Modify Without Adding Tests First)

### 19. Worker Pipeline
**Files:** `worker/*.py`
**Why:** Only basic pytest coverage. No integration tests for full pipeline.
**Risk:** Silent failures, data corruption
**Test coverage:** ~30% (estimated)

### 20. API Routes
**Files:** `api/src/routes/*.ts`
**Why:** Limited test coverage. No load testing, no chaos testing.
**Risk:** API failures under load, edge case bugs
**Test coverage:** ~40% (estimated)

### 21. Neural Network Models
**Files:** `worker/nn_*.py`
**Why:** No unit tests for model forward/backward passes. No accuracy tests.
**Risk:** Silent model degradation
**Test coverage:** ~10% (estimated)

---

## COMPONENTS WHERE OPTIMIZATION COULD CREATE REGRESSIONS

### 22. Index Strategy
**Files:** `api/schema.sql`, `api/migrations/*.sql`
**Why:** 33 indexes on news_articles. Removing any could slow queries 10-100x.
**Risk:** Query performance collapse
**Approach:** Benchmark before removing, never remove in production

### 23. Cache TTLs
**Files:** `api/src/cache.ts`, `api/src/routes/*.ts`
**Why:** TTLs are tuned for specific access patterns. Changing could cause cache stampedes.
**Risk:** Performance degradation, increased DB load
**Approach:** A/B test changes, monitor cache hit rates

### 24. Worker Concurrency
**Files:** `api/src/queue/workerPool.ts`, `api/src/queue/kindConfig.ts`
**Why:** 4 slots with soft caps. Changing could cause resource exhaustion or starvation.
**Risk:** Job failures, memory issues
**Approach:** Load test changes, monitor resource usage

### 25. Rate Limiting
**Files:** `api/src/ratelimit.ts`
**Why:** In-process per-IP limiter. Changing thresholds could affect legitimate users.
**Risk:** User lockout, abuse potential
**Approach:** A/B test, monitor rate limit hits

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| Stable | 5 | Do not modify without strong evidence |
| Fragile | 5 | Modify with extreme caution |
| Poorly understood | 4 | Investigate before changing |
| Highly coupled | 4 | Understand ripple effects first |
| Lacking tests | 3 | Add tests before modifying |
| Optimization risk | 4 | Benchmark before changing |

**Total: 25 components requiring caution**

**Golden Rule:** If you didn't write it and don't understand it, don't change it. If you must change it, write tests first, benchmark before/after, and have a rollback plan.
