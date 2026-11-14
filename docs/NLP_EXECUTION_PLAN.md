# XYZO NLP Intelligence Pipeline - Execution Plan

## Phase 1: Full Extraction (Priority: CRITICAL)

### Run Full Extraction
```bash
XYZO_DB_DSN="postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo" \
  nohup python -m worker.extract_nlp --limit 1000000 --batch-size 100 > /tmp/nlp_extraction.log 2>&1 &

# Monitor progress
tail -f /tmp/nlp_extraction.log
```

### Verify Extraction Progress
```bash
# Check counts
XYZO_DB_DSN="..." python -c "
from worker.db import connect
with connect() as conn:
    total = conn.execute('SELECT COUNT(*) FROM article_facts').fetchone()['count']
    complete = conn.execute('''
        SELECT COUNT(*) FROM article_facts 
        WHERE temporal_features IS NOT NULL 
        AND quantity_features IS NOT NULL 
        AND entity_features IS NOT NULL 
        AND claim_features IS NOT NULL 
        AND attribution_features IS NOT NULL 
        AND linguistic_features IS NOT NULL
    ''').fetchone()['count']
    print(f'Total: {total}, Complete: {complete}')
"
```

---

## Phase 2: Insights API Endpoints (Priority: HIGH)

### Endpoints to Build

```typescript
// GET /api/insights/:article_id
// Returns all NLP features for an article

// GET /api/insights/location/:location_id
// Returns aggregated NLP features for all articles at a location
// - temporal_distribution (past/present/future events)
// - claim_types (what predicates are most common)
// - attribution breakdown (official/expert/witness sources)
// - entity density
// - technical vocabulary prevalence

// GET /api/insights/trending
// Returns trending claims/events by location
// - burst detection
// - novelty scores
// - claim acceleration

// GET /api/insights/search
// Search articles by claim predicates, entity types, temporal modes
// "show me all articles where someone PLANNED something in Indonesia"

// GET /api/insights/entity/:entity_name
// Returns all claims involving an entity
// - As subject (what did X do)
// - As object (what happened to X)
```

### Response Shape
```typescript
// GET /api/insights/location/123
{
  location_id: 123,
  temporal_distribution: {
    past: 0.45,
    present: 0.35,
    future: 0.20
  },
  claim_types: {
    killed: 127,
    injured: 43,
    announced: 89,
    increase: 56,
    // ...
  },
  attribution: {
    official: 0.40,
    expert: 0.25,
    witness: 0.20,
    company: 0.10,
    anonymous: 0.05
  },
  entity_stats: {
    total: 2341,
    unique: 567,
    person_count: 234,
    organization_count: 123,
    location_count: 89
  },
  technical_domains: {
    conflict: 0.45,
    politics: 0.30,
    climate: 0.15,
    health: 0.10
  },
  linguistic: {
    avg_entropy: 4.2,
    avg_type_token_ratio: 0.52
  }
}
```

---

## Phase 3: Geospatial Roles (Priority: MEDIUM)

### Problem
Current extraction doesn't distinguish:
- **Event Location**: WHERE the event happened ("flood in Jakarta killed 10")
- **Source Location**: WHERE the information came from ("officials in Washington said...")

### Implementation

```sql
-- Add columns to article_facts
ALTER TABLE article_facts ADD COLUMN event_location_id INTEGER REFERENCES news_locations(id);
ALTER TABLE article_facts ADD COLUMN source_location_id INTEGER REFERENCES news_locations(id);
```

### Extraction Logic
```python
def extract_geographic_roles(text, article_location_id):
    # Event location: location mentioned in claim predicate
    # - "killed 47 in Jakarta" -> Jakarta is event_location
    # - "flood struck Lagos" -> Lagos is event_location

    # Source location: location of attribution
    # - "officials in Washington said" -> Washington is source_location
    # - "according to London-based analysts" -> London is source_location

    # Compare to article's primary location
    # If event_location != article_location -> story about external event
    # If source_location != article_location -> foreign correspondent/sourcing
```

---

## Phase 4: Aggregations by Location/Time (Priority: HIGH)

### Pre-compute Aggregations

```sql
-- Location temporal summary
CREATE TABLE location_temporal_summary AS
SELECT
    l.id as location_id,
    af.temporal_features->>'temporal_class' as temporal_class,
    COUNT(*) as article_count,
    COUNT(DISTINCT af.article_id) as unique_articles
FROM article_facts af
JOIN news_locations l ON l.id = af.article_id  -- need mapping
GROUP BY l.id, temporal_class;

-- Location claim summary
CREATE TABLE location_claim_summary AS
SELECT
    l.id as location_id,
    (jsonb_object_keys(af.claim_features->'claim_types')) as claim_type,
    COUNT(*) as count
FROM article_facts af
JOIN news_locations l ON l.id = af.article_id
GROUP BY l.id, claim_type;

-- Time-series for burst detection
CREATE TABLE temporal_burst_series AS
SELECT
    date_trunc('day', a.published_at) as day,
    af.temporal_features->>'temporal_class' as temporal_class,
    COUNT(*) as article_count
FROM article_facts af
JOIN news_articles a ON a.id = af.article_id
WHERE a.published_at IS NOT NULL
GROUP BY day, temporal_class;
```

### Materialized Views for Fast Queries
```sql
CREATE MATERIALIZED VIEW mv_location_claims AS
SELECT
    l.id as location_id,
    l.name as location_name,
    l.country_code,
    af.claim_features->>'claim_types' as claims,
    af.temporal_features->>'temporal_class' as temporal_class,
    af.attribution_features->>'official_source_count' as official_count,
    a.published_at
FROM article_facts af
JOIN news_articles a ON a.id = af.article_id
JOIN news_locations la ON la.id = a.location_id
JOIN news_locations l ON l.id = la.id;  -- may need different join
```

---

## Phase 5: Knowledge Graph from Claims (Priority: HIGH)

### Graph Schema
```sql
CREATE TABLE claim_nodes (
    id SERIAL PRIMARY KEY,
    entity_name TEXT UNIQUE,
    entity_type TEXT, -- person, organization, location, event
    first_seen TIMESTAMP,
    last_seen TIMESTAMP,
    claim_count INTEGER
);

CREATE TABLE claim_edges (
    id SERIAL PRIMARY KEY,
    subject_id INTEGER REFERENCES claim_nodes(id),
    predicate TEXT, -- killed, announced, invested, etc
    object_id INTEGER REFERENCES claim_nodes(id),
    location_id INTEGER REFERENCES news_locations(id),
    article_id INTEGER REFERENCES news_articles(id),
    certainty TEXT, -- confirmed, reported, planned
    published_at TIMESTAMP,
    UNIQUE(subject_id, predicate, object_id, article_id)
);

CREATE INDEX idx_edges_subject ON claim_edges(subject_id);
CREATE INDEX idx_edges_predicate ON claim_edges(predicate);
CREATE INDEX idx_edges_object ON claim_edges(object_id);
CREATE INDEX idx_edges_location ON claim_edges(location_id);
```

### Build Graph from Claims
```python
def build_knowledge_graph():
    """Extract claim triples and populate graph tables."""

    with connect() as conn:
        rows = conn.execute("""
            SELECT
                af.article_id,
                a.published_at,
                af.claim_features
            FROM article_facts af
            JOIN news_articles a ON a.id = af.article_id
            WHERE af.claim_features IS NOT NULL
            AND af.claim_features->'claims' != '[]'::jsonb
        """).fetchall()

    for row in rows:
        claims = row['claim_features'].get('claims', [])
        for claim in claims:
            subject = claim['subject']
            predicate = claim['predicate']
            obj = claim['object']
            location = claim.get('location')
            certainty = claim['certainty']

            # Upsert nodes
            subject_id = upsert_node(subject, infer_type(subject))
            object_id = upsert_node(obj, infer_type(obj))

            # Upsert edge
            upsert_edge(subject_id, predicate, object_id,
                       location_id, row['article_id'],
                       certainty, row['published_at'])
```

### Knowledge Graph Queries
```sql
-- What has entity X done?
SELECT predicate, object_id, published_at
FROM claim_edges
WHERE subject_id = (SELECT id FROM claim_nodes WHERE entity_name = 'Tesla')
ORDER BY published_at DESC;

-- What happened to entity Y?
SELECT subject_id, predicate, published_at
FROM claim_edges
WHERE object_id = (SELECT id FROM claim_nodes WHERE entity_name = 'Indonesia')
ORDER BY published_at DESC;

-- Who announced plans in location Z?
SELECT cn.entity_name, ce.predicate, ce.article_id
FROM claim_edges ce
JOIN claim_nodes cn ON cn.id = ce.subject_id
WHERE ce.predicate IN ('announce_future', 'plans')
AND ce.location_id = 123;

-- Trending events (burst detection)
SELECT predicate, COUNT(*) as recent_count
FROM claim_edges
WHERE published_at > NOW() - INTERVAL '24 hours'
GROUP BY predicate
ORDER BY recent_count DESC;
```

---

## Phase 6: Novelty & Burst Detection (Priority: MEDIUM)

### Novelty Score
```python
def compute_novelty(entity_name, location_id):
    """How new/unusual is this entity at this location?"""

    with connect() as conn:
        # Check if entity has been seen at this location before
        prev_count = conn.execute("""
            SELECT COUNT(*)
            FROM claim_edges ce
            JOIN claim_nodes cn ON cn.id = ce.subject_id
            WHERE cn.entity_name = %s
            AND ce.location_id = %s
            AND ce.published_at < NOW() - INTERVAL '30 days'
        """, (entity_name, location_id)).fetchone()['count']

        if prev_count == 0:
            return 1.0  # Completely new
        else:
            # Has appeared before - compute rareness
            total_appearances = conn.execute("""
                SELECT COUNT(*)
                FROM claim_edges
                WHERE location_id = %s
            """, (location_id,)).fetchone()['count']

            return prev_count / total_appearances  # Lower = more novel
```

### Burst Detection
```sql
-- Detect sudden spikes in claim types
WITH hourly_counts AS (
    SELECT
        date_trunc('hour', published_at) as hour,
        (claim_features->'claim_types'->>'killed')::int as killed_count
    FROM article_facts af
    JOIN news_articles a ON a.id = af.article_id
    WHERE published_at > NOW() - INTERVAL '7 days'
),
historical_avg AS (
    SELECT AVG(killed_count) as avg, STDDEV(killed_count) as stddev
    FROM hourly_counts
),
current_hour AS (
    SELECT killed_count FROM hourly_counts
    ORDER BY hour DESC LIMIT 1
)
SELECT
    (SELECT avg FROM historical_avg) as mean,
    (SELECT killed_count FROM current_hour) as current,
    ((SELECT killed_count FROM current_hour) - (SELECT avg FROM historical_avg)) /
    NULLIF((SELECT stddev FROM historical_avg), 0) as z_score;
```

---

## Phase 7: Attribution Quality Scores (Priority: MEDIUM)

```python
def compute_attribution_quality(article_id):
    """Score how reliable the sourcing is for an article."""

    with connect() as conn:
        af = conn.execute("""
            SELECT attribution_features
            FROM article_facts
            WHERE article_id = %s
        """, (article_id,)).fetchone()

    attr = af['attribution_features']

    # Quality weights
    weights = {
        'official': 0.9,
        'expert': 0.85,
        'witness': 0.7,
        'company': 0.6,
        'media': 0.5,
        'anonymous': 0.2,
    }

    total_sources = (
        attr['official_source_count'] +
        attr['expert_source_count'] +
        attr['witness_source_count'] +
        attr['company_source_count'] +
        attr['anonymous_source_count']
    )

    if total_sources == 0:
        return 0.0

    weighted_sum = sum(
        count * weights.get(source_type, 0.3)
        for source_type, count in [
            ('official', attr['official_source_count']),
            ('expert', attr['expert_source_count']),
            ('witness', attr['witness_source_count']),
            ('company', attr['company_source_count']),
            ('anonymous', attr['anonymous_source_count']),
        ]
    )

    return weighted_sum / total_sources
```

---

## Execution Timeline

| Phase | Priority | Estimated Time | Dependencies |
|-------|----------|----------------|--------------|
| 1. Full Extraction | CRITICAL | 4-6 hours | None |
| 2. Insights API | HIGH | 2-3 hours | Phase 1 |
| 3. Geospatial Roles | MEDIUM | 2 hours | Phase 1 |
| 4. Aggregations | HIGH | 1 hour | Phase 1 |
| 5. Knowledge Graph | HIGH | 3-4 hours | Phase 2 |
| 6. Novelty/Burst | MEDIUM | 2 hours | Phase 4 |
| 7. Attribution Scores | MEDIUM | 1 hour | Phase 1 |

**Total: ~15-18 hours of implementation**

---

## Quick Wins (First 30 Minutes)

```bash
# 1. Run extraction on subset to verify
XYZO_DB_DSN="..." python -m worker.extract_nlp --limit 1000 --batch-size 50

# 2. Check coverage
XYZO_DB_DSN="..." python -c "
from worker.db import connect
with connect() as conn:
    print('Total:', conn.execute('SELECT COUNT(*) FROM article_facts').fetchone()['count'])
"

# 3. Add simple API endpoint for insights
# (see api/src/routes/insights.ts - already has skeleton)
```

---

## Files to Create/Modify

### New Files
- `worker/build_knowledge_graph.py` - Graph construction
- `worker/compute_burst.py` - Burst detection
- `worker/compute_novelty.py` - Novelty scoring
- `api/src/routes/knowledge_graph.ts` - Graph API
- `api/src/routes/insights_enhanced.ts` - Enhanced insights

### Modify
- `worker/extract_nlp.py` - Add geographic role extraction
- `api/src/routes/insights.ts` - Add new endpoints
- `article_facts` table - Add event_location_id, source_location_id
- `docs/NLP_FEATURE_STACK.md` - Update with completed features
