# XYZO FILE-LEVEL PRIORITY MATRIX

## Top 25 Files That Deserve Engineering Attention

| Rank | File | LOC | Importance | Performance Risk | DB Risk | AI Opportunity | Security Risk | Complexity | Priority |
|------|------|----:| ----------:| ---------------:| ------:| -------------:| ------------:| ---------:| -------:|
| 1 | `public_html/app.js` | 13,823 | 100 | 80 | 20 | 30 | 40 | 95 | **P0** |
| 2 | `worker/nn_train.py` | 1,262 | 90 | 30 | 40 | 95 | 10 | 85 | **P0** |
| 3 | `api/src/routes/pins.ts` | 746 | 95 | 85 | 90 | 20 | 30 | 75 | **P0** |
| 4 | `worker/auto_categorize.py` | 750 | 85 | 70 | 60 | 40 | 20 | 70 | **P1** |
| 5 | `api/src/routes/search.ts` | 131 | 80 | 75 | 70 | 50 | 30 | 60 | **P1** |
| 6 | `worker/extract.py` | 500 | 85 | 60 | 50 | 80 | 20 | 75 | **P1** |
| 7 | `worker/geocode.py` | 400 | 80 | 85 | 60 | 30 | 20 | 65 | **P1** |
| 8 | `worker/cluster.py` | 250 | 75 | 60 | 70 | 40 | 10 | 70 | **P1** |
| 9 | `api/src/routes/feed.ts` | 300 | 80 | 70 | 60 | 20 | 20 | 60 | **P1** |
| 10 | `worker/nn_infer.py` | 800 | 85 | 50 | 40 | 85 | 10 | 80 | **P1** |
| 11 | `api/src/queue/workerPool.ts` | 400 | 75 | 70 | 50 | 20 | 30 | 80 | **P2** |
| 12 | `worker/learn.py` | 300 | 70 | 50 | 60 | 60 | 10 | 65 | **P2** |
| 13 | `api/src/routes/analytics.ts` | 2,028 | 70 | 60 | 70 | 30 | 40 | 70 | **P2** |
| 14 | `worker/classify.py` | 400 | 65 | 40 | 30 | 70 | 10 | 60 | **P2** |
| 15 | `api/src/routes/events.ts` | 300 | 70 | 50 | 60 | 20 | 20 | 55 | **P2** |
| 16 | `worker/nn_features.py` | 793 | 75 | 40 | 50 | 80 | 10 | 70 | **P2** |
| 17 | `api/src/routes/tags.ts` | 135 | 60 | 50 | 60 | 20 | 20 | 45 | **P2** |
| 18 | `worker/story_linker.py` | 300 | 65 | 50 | 60 | 40 | 10 | 65 | **P3** |
| 19 | `api/src/routes/explore.ts` | 959 | 60 | 50 | 50 | 30 | 30 | 60 | **P3** |
| 20 | `worker/ai_client.py` | 200 | 70 | 60 | 30 | 50 | 20 | 55 | **P3** |
| 21 | `api/src/auth.ts` | 100 | 60 | 20 | 30 | 10 | 90 | 50 | **P3** |
| 22 | `public_html/analytics.js` | 534 | 50 | 40 | 20 | 20 | 50 | 45 | **P3** |
| 23 | `worker/embeddings.py` | 200 | 55 | 50 | 40 | 60 | 10 | 55 | **P3** |
| 24 | `api/src/routes/locations.ts` | 127 | 55 | 40 | 50 | 20 | 20 | 40 | **P3** |
| 25 | `worker/place_disambiguation.py` | 150 | 50 | 30 | 40 | 30 | 10 | 50 | **P3** |

---

## Priority Definitions

### P0 — Critical (Fix Immediately)
- **app.js** — Monolithic frontend, 13K LOC, no TypeScript, single point of failure
- **nn_train.py** — 8 of 9 models have zero training data, entire NN system is non-functional
- **pins.ts** — Core API, complex PostGIS queries, performance bottleneck

### P1 — High (Fix This Week)
- **auto_categorize.py** — Fast-path categorization, 85% of articles use this
- **search.ts** — Search expansion needed, 15% zero-result rate
- **extract.py** — AI extraction, primary intelligence pipeline
- **geocode.py** — Geocoding, critical for accuracy
- **cluster.py** — Event clustering, core functionality
- **feed.ts** — Real-time feed, 33K calls/day
- **nn_infer.py** — NN inference, currently not producing results

### P2 — Medium (Fix This Month)
- **workerPool.ts** — Worker management, critical but stable
- **learn.py** — Source learning, affects content quality
- **analytics.ts** — Analytics API, large but stable
- **classify.py** — Category classifier, only trained model
- **events.ts** — Events API, stable
- **nn_features.py** — Feature extraction, just improved
- **tags.ts** — Tag API, just improved

### P3 — Low (Fix Next Quarter)
- **story_linker.py** — Story linking, stable
- **explore.ts** — Source discovery, stable
- **ai_client.py** — AI client, stable
- **auth.ts** — Authentication, stable
- **analytics.js** — Frontend analytics, stable
- **embeddings.py** — Embeddings, stable
- **locations.ts** — Location search, stable
- **place_disambiguation.py** — Place disambiguation, stable

---

## Score Explanation

### Importance (0-100)
How critical is this file to XYZO's core functionality?
- 100: Core functionality, system fails without it
- 80: Important functionality, significant degradation without it
- 60: Supporting functionality, minor degradation without it
- 40: Nice-to-have, minimal impact without it

### Performance Risk (0-100)
How likely is this file to cause performance issues?
- 100: Almost certain to cause issues under load
- 80: Likely to cause issues with growth
- 60: May cause issues in edge cases
- 40: Unlikely to cause performance issues

### DB Risk (0-100)
How likely is this file to cause database issues?
- 100: Almost certain to cause DB issues
- 80: Likely to cause DB issues with growth
- 60: May cause DB issues in edge cases
- 40: Unlikely to cause DB issues

### AI Opportunity (0-100)
How much could improving this file improve AI capabilities?
- 100: Transformative improvement possible
- 80: Significant improvement possible
- 60: Moderate improvement possible
- 40: Minor improvement possible

### Security Risk (0-100)
How likely is this file to have security vulnerabilities?
- 100: Almost certain to have vulnerabilities
- 80: Likely to have vulnerabilities
- 60: May have vulnerabilities in edge cases
- 40: Unlikely to have vulnerabilities

### Complexity (0-100)
How complex is this file to understand and modify?
- 100: Extremely complex, hard to understand
- 80: Very complex, requires deep knowledge
- 60: Moderately complex, requires some knowledge
- 40: Relatively simple, easy to understand

### Priority Score
Calculated as: `(Importance × 0.3) + (Performance Risk × 0.2) + (DB Risk × 0.15) + (AI Opportunity × 0.2) + (Security Risk × 0.1) + (Complexity × 0.05)`

---

## Key Insights

### Where to Focus Engineering Attention

1. **app.js (P0)** — The 13K LOC monolithic frontend is the biggest maintenance risk. Splitting into modules would improve maintainability dramatically.

2. **nn_train.py (P0)** — The entire neural network system is non-functional due to zero labeled training data. Fixing this unlocks 7 models.

3. **pins.ts (P0)** — The core API with complex PostGIS queries. Performance optimization here benefits all users.

4. **auto_categorize.py (P1)** — The fast-path categorization handles 85% of articles. Improving accuracy here has massive impact.

5. **search.ts (P1)** — Search expansion would reduce zero-result rate from 15% to <10%.

### Where NOT to Focus

1. **Stable components** (auth.ts, analytics.js, embeddings.py) — These work well and are low-risk.

2. **Low-complexity files** (locations.ts, place_disambiguation.py) — These are simple and unlikely to cause issues.

3. **Low-importance files** (story_linker.py, explore.ts) — These are supporting functionality, not core.

---

## Recommended Action Plan

### Week 1: P0 Items
1. Split app.js into modules (or at least document the plan)
2. Run auto-labeling for geolocation, train nn_train.py
3. Benchmark pins.ts queries, add missing indexes

### Week 2-4: P1 Items
4. Implement search expansion in search.ts
5. Improve auto_categorize.py accuracy
6. Verify nn_infer.py is producing results

### Month 2-3: P2 Items
7. Optimize workerPool.ts for better resource utilization
8. Improve learn.py source scoring
9. Add monitoring to analytics.ts

### Month 4-6: P3 Items
10. Improve story_linker.py algorithm
11. Add A/B testing to explore.ts
12. Enhance ai_client.py with better fallbacks
