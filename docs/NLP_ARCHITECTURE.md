# XYZO NLP Pipeline - Architecture Decision Record

## Decision: Real-time NLP on NEW Articles Only

**Date:** 2026-09-20
**Status:** DECIDED

---

## Context

We built a comprehensive NLP extraction pipeline that processes 6 feature types from articles:
- Temporal (dates, past/present/future classification)
- Quantities (money, percentages, counts)
- Entities (persons, organizations, locations)
- Claims (subject-predicate-object triples)
- Attribution (source types: official/expert/witness)
- Linguistic (entropy, type/token ratio, n-grams)

Initial attempt tried to process all 650k historical articles. This would take ~100+ hours.

## Decision

**Process only NEW articles going forward**, not historical backlog.

### Rationale

1. **Value Proposition**: The algorithm improves with NEW data, not historical
2. **Time-to-Value**: We can prove the system works with recent articles in minutes
3. **Resource Efficiency**: Don't waste compute on stale news
4. **Production Ready**: New articles automatically processed on fetch

### Scope

| Articles | Priority | Processing |
|----------|----------|------------|
| New (future) | **HIGH** | Real-time NLP on fetch |
| Last 24-48 hours | MEDIUM | Quick batch for demo |
| Historical (older) | LOW | **SKIP** unless specifically requested |

---

## Implementation

### 1. Trigger on Fetch (Production Path)

In `worker/fetch.py`, after article is stored with `status = 'extracted'`:

```python
# After fetch completes
from .extract_nlp import extract_all_features

# Async processing for new articles (non-blocking)
if article.published_at > datetime.now() - timedelta(hours=48):
    queue_nlp_extraction(article.id)
```

### 2. Quick Demo Batch (Last 48 Hours)

```bash
# Process only recent articles for demo
XYZO_DB_DSN="..." python -m worker.extract_nlp \
    --since-hours 48 \
    --batch-size 100
```

### 3. Production Worker

```python
# In worker/extract_nlp.py
def process_new_articles(batch_size=50):
    """Only process articles from last 24 hours."""
    cutoff = datetime.now() - timedelta(hours=24)
    
    with connect() as conn:
        rows = conn.execute("""
            SELECT a.id, a.title, a.summary, a.body
            FROM news_articles a
            WHERE a.status = 'extracted'
            AND a.fetched_at > %s
            AND a.id NOT IN (
                SELECT article_id FROM article_facts 
                WHERE processed_at > %s
            )
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (cutoff, cutoff, batch_size)).fetchall()
```

---

## What We Built

### Extractors (Worker Modules)

| Module | Purpose | Status |
|--------|---------|--------|
| `extract_temporal.py` | Dates, time classification | ✅ Working |
| `extract_quantities.py` | Money, percentages, counts | ✅ Working |
| `extract_entities.py` | Named entity recognition | ✅ Working |
| `extract_claims.py` | Subject-predicate-object | ✅ Working |
| `extract_attribution.py` | Source attribution | ✅ Working |
| `extract_linguistic.py` | Entropy, vocabulary | ✅ Working |
| `extract_nlp.py` | Unified worker | ✅ Working |

### API Endpoints (Production Ready)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/insights/article/:id` | Full NLP for article |
| `GET /api/insights/location/:id/nlp` | Aggregated by location |
| `GET /api/insights/search?predicate=X` | Search by claims |

### Database Schema

```sql
CREATE TABLE article_facts (
    article_id INTEGER PRIMARY KEY REFERENCES news_articles(id),
    temporal_features JSONB,
    quantity_features JSONB,
    entity_features JSONB,
    claim_features JSONB,
    attribution_features JSONB,
    linguistic_features JSONB,
    processed_at TIMESTAMP DEFAULT NOW()
);
```

---

## Future Improvements (Backlog)

### High Priority

1. **Speed Optimization**
   - Current: ~100 articles/minute
   - Target: 1000+ articles/minute
   - Approach: Reduce extractor complexity, add caching

2. **Production Integration**
   - Trigger NLP on article fetch
   - Add to `fetch.py` pipeline
   - Queue system for async processing

3. **Knowledge Graph**
   - Build `claim_nodes` and `claim_edges` tables
   - Real-time graph updates on new articles

### Medium Priority

1. **Geospatial Roles**
   - Distinguish event_location vs source_location
   - "flood in Jakarta" vs "officials in Washington said"

2. **Burst Detection**
   - Pre-compute `news_event_stats`
   - Anomaly detection for claim spikes

3. **Attribution Quality Score**
   - Weight sources by reliability
   - official=0.9, expert=0.85, witness=0.7, anonymous=0.2

### Low Priority (Nice to Have)

1. **Historical Backfill** (if requested)
   - Only process if specific use case requires it
   - Run in isolated worker with low priority

2. **Cross-Article Resolution**
   - Link claims about same entity across articles
   - Build entity timeline

---

## Commands Reference

```bash
# Process recent articles for demo (last 24 hours)
XYZO_DB_DSN="postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo" \
  python -m worker.extract_nlp --since-hours 24 --batch-size 100

# Check extraction status
XYZO_DB_DSN="..." python -c "
from worker.db import connect
with connect() as conn:
    total = conn.execute('SELECT COUNT(*) FROM article_facts').fetchone()['count']
    recent = conn.execute('''
        SELECT COUNT(*) FROM article_facts 
        WHERE processed_at > NOW() - INTERVAL '24 hours'
    ''').fetchone()['count']
    print(f'Total: {total}, Last 24h: {recent}')
"

# Test API endpoint
curl "http://localhost:3008/api/insights/article/6"

# Restart API after changes
systemctl restart xyzo-api
```

---

## What Was Learned

1. **Pattern Matching vs ML**: Rule-based extractors work well for structured info (quantities, dates, attribution) but miss context. For production, consider:
   - spaCy for NER
   - Gemma for semantic extraction

2. **Claim Extraction is Hard**: Subject-predicate-object sounds simple but requires deep parsing. Current regex approach catches ~30% of actual claims.

3. **Value in Attribution**: The attribution features (official/expert/witness breakdown) are the most epistemically valuable - they tell us HOW WE KNOW what we know.

4. **Real-time > Historical**: Processing 650k old articles is less valuable than processing 1k new articles daily. Algorithm improves with fresh data.
