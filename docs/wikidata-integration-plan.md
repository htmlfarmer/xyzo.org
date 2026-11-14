# XYZO Wikidata Integration Plan

**Goal**: Transform Wikidata (119M entities, 183M claims) from an unindexed 700GB blob into XYZO's "entity skeleton" — a queryable knowledge graph that tells XYZO what's what, where it is, and how everything connects.

---

## Phase 1: Foundation (Critical Path)

### 1.1 Build Wikipedia → Wikidata QID Bridge
**Status**: ❌ MISSING — the `wiki_articles` table has NO `wikidata_qid` column

The `wd_entities` table has `enwiki_title` — we can join Wikipedia titles to Wikidata QIDs.

```sql
-- Add wikidata_qid to wiki_articles (run once)
ALTER TABLE wiki_articles ADD COLUMN wikidata_qid TEXT;
CREATE INDEX idx_wiki_wikidata_qid ON wiki_articles(wiki_id) INCLUDE (wikidata_qid);

-- Populate via join on enwiki_title = title
UPDATE wiki_articles w
SET wikidata_qid = e.id
FROM wd_entities e
WHERE e.enwiki_title = w.title
  AND w.wikidata_qid IS NULL;

-- For unmatched, try case-insensitive
UPDATE wiki_articles w
SET wikidata_qid = e.id
FROM wd_entities e
WHERE lower(e.enwiki_title) = lower(w.title)
  AND w.wikidata_qid IS NULL;
```

**Worker script**: `worker/wikidata/wiki_wikidata_bridge.py`
- Batch update with `COPY` for speed
- Log unmatched Wikipedia titles → discover gaps in Wikidata

### 1.2 Create xyzo_entities Table (Entity Skeleton)
**Status**: ❌ Does NOT exist

```sql
CREATE TABLE xyzo_entities (
    id              TEXT PRIMARY KEY,        -- QID (Q12345)
    label_en        TEXT,
    description_en  TEXT,
    entity_type     TEXT,                    -- 'item' or 'property'
    lat             DOUBLE PRECISION,
    lon             DOUBLE PRECISION,
    geog            GEOGRAPHY(POINT, 4326),
    enwiki_title    TEXT,                   -- Wikipedia title
    wikipedia_url   TEXT,
    aliases         JSONB,                  -- [{lang, aliases[]}]
    sitelinks       JSONB,                  -- {enwiki: "...", frwiki: "..."}
    importance_score DOUBLE PRECISION DEFAULT 0,

    -- Pre-computed importance metrics
    num_claims      INTEGER DEFAULT 0,
    num_sitelinks   INTEGER DEFAULT 0,
    entity_rank     TEXT,                   -- 'top', 'high', 'medium', 'low'

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Spatial index for geographic queries
CREATE INDEX idx_xyzo_entities_geog ON xyzo_entities USING GIST(geog);

-- Text search index
CREATE INDEX idx_xyzo_entities_label_trgm ON xyzo_entities USING GIN(label_en gin_trgm_ops);

-- Type filter index
CREATE INDEX idx_xyzo_entities_type ON xyzo_entities(entity_type) WHERE entity_type = 'item';
```

**Populate from wd_entities** (sample first, don't do full 119M):

```python
# worker/wikidata/populate_xyzo_entities.py
"""
Phase 1: Sample 5-10M "important" entities
Priority: entities with coordinates, sitelinks, or high claim counts

Run:
    python3 -m worker.wikidata.populate_xyzo_entities --sample 0.1
    python3 -m worker.wikidata.populate_xyzo_entities --full  # after testing
"""
```

**Entity importance scoring** (pre-computed):
- `num_sitelinks` × 10 + `num_claims` × 1 + `has_coordinates` × 100
- Top universe: countries, cities >50k, universities, companies, airports, hospitals
- Wikidata QID → importance mapping stored for fast lookup

### 1.3 Create xyzo_entity_relationships Table
**Status**: ❌ Does NOT exist

```sql
CREATE TABLE xyzo_entity_relationships (
    id              BIGSERIAL PRIMARY KEY,
    subject_qid     TEXT NOT NULL,          -- Q12345
    predicate       TEXT NOT NULL,          -- P31, P17, P131, etc.
    object_qid      TEXT,                   -- Target QID (if entity reference)
    object_text     TEXT,                   -- Literal value (if not entity)
    qualifiers      JSONB,                  -- {P580: "2020-01-01", P585: "..."}
    rank            TEXT,                   -- 'normal', 'preferred', 'deprecated'

    -- Pre-computed usefulness
    usefulness      DOUBLE PRECISION DEFAULT 0,

    created_at      TIMESTAMPTZ DEFAULT now(),

    FOREIGN KEY (subject_qid) REFERENCES xyzo_entities(id) ON DELETE CASCADE
);

-- Indexes for key traversals
CREATE INDEX idx_xyzo_rel_subject ON xyzo_entity_relationships(subject_qid);
CREATE INDEX idx_xyzo_rel_predicate ON xyzo_entity_relationships(predicate);
CREATE INDEX idx_xyzo_rel_object ON xyzo_entity_relationships(object_qid);
CREATE INDEX idx_xyzo_rel_lookup ON xyzo_entity_relationships(subject_qid, predicate);
```

**Key properties to materialize first** (from audit: P31, P17, P131, P106, P279, P276, P159):

```python
# worker/wikidata/populate_xyzo_relationships.py
"""
Populate xyzo_entity_relationships from wd_claims_flat

Priority properties:
1. P31 (instance of) — entity classification
2. P17 (country) — geographic ownership
3. P131 (located in) — administrative hierarchy
4. P276 (location) — physical location
5. P279 (subclass of) — ontology
6. P159 (headquarters) — org location
7. P150 (contains) — administrative containment
8. P361 (part of) — compositional hierarchy
9. P106 (occupation) — person roles
10. P463 (member of) — organizational membership
11. P527 (has part) — composition
12. P625 (coordinate location) — spatial position

Run:
    python3 -m worker.wikidata.populate_xyzo_relationships --properties P31,P17,P131
    python3 -m worker.wikidata.populate_xyzo_relationships --all  # after testing
"""
```

---

## Phase 2: Integration (Wire Wikidata into XYZO Pipeline)

### 2.1 Entity Resolution — Populate news_entities.wikidata_id
**Status**: ⚠️ Column exists but is EMPTY

```python
# worker/wikidata/resolve_wikidata_entities.py
"""
Resolve news_entities.name → Wikidata QID

Methods (in priority order):
1. Exact match on xyzo_entities.label_en
2. Case-insensitive match
3. Alias match (aliases JSONB)
4. Trigram fuzzy match (for org names)
5. Wikidata API fallback (wbsearchentities)

Run:
    python3 -m worker.wikidata.resolve_wikidata_entities --batch 1000
    python3 -m worker.wikidata.resolve_wikidata_entities --watch  # continuous
"""
```

**Integration into cluster.py** (line 134 `_upsert_entity`):
- After entity upsert, resolve wikidata_id
- Write resolved QID to `news_entities.wikidata_id`

### 2.2 Build Entity Type Verifier (Replace Keyword Guessing)
**Status**: ❌ cluster.py lines 152-154 use keyword guessing

```python
# worker/wikidata/entity_type_verifier.py
"""
Replace keyword-based entity type guessing with Wikidata P31 lookup.

Current (broken):
    type_ = "organization" if any(k in name.lower() for k in (
        "ministry", "police", "government", "agency"...
    )) else "person"

Better:
    entity_type = get_instance_of(wikidata_qid)
    # Q5 (human) → "person"
    # Q43229 (event) → "event"
    # Q41176 (organization) → "organization"
    # Q486972 (building) → "place"
    # Q17347023 (meeting) → "event"
"""
```

### 2.3 Build xyzo_place_context Table
**Status**: ❌ Does not exist

```sql
CREATE TABLE xyzo_place_context (
    place_qid       TEXT PRIMARY KEY,           -- Q12345 (city QID)
    place_name      TEXT,

    -- Geographic hierarchy
    country_qid     TEXT,
    country_name    TEXT,
    region_qid      TEXT,
    region_name     TEXT,

    -- Coordinates
    lat             DOUBLE PRECISION,
    lon             DOUBLE PRECISION,

    -- Pre-computed context
    population      INTEGER,
    num_universities INTEGER DEFAULT 0,
    num_hospitals  INTEGER DEFAULT 0,
    num_companies  INTEGER DEFAULT 0,
    num_airports   INTEGER DEFAULT 0,
    num_museums    INTEGER DEFAULT 0,
    num_religious_sites INTEGER DEFAULT 0,
    num_sports_venues INTEGER DEFAULT 0,

    -- Wikipedia article count (richness proxy)
    wikipedia_articles INTEGER DEFAULT 0,

    -- XYZO current coverage
    xyzo_article_count INTEGER DEFAULT 0,
    xyzo_source_count  INTEGER DEFAULT 0,
    xyzo_event_count   INTEGER DEFAULT 0,

    -- Computed scores
    coverage_score      DOUBLE PRECISION DEFAULT 0,  -- actual/expected
    coverage_gap_score  DOUBLE PRECISION DEFAULT 0,  -- missing coverage
    news_desert_score   DOUBLE PRECISION DEFAULT 0,  -- high need, low coverage

    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_xyzo_place_country ON xyzo_place_context(country_qid);
CREATE INDEX idx_xyzo_place_gap ON xyzo_place_context(coverage_gap_score DESC);
CREATE INDEX idx_xyzo_place_desert ON xyzo_place_context(news_desert_score DESC);
```

**Populate with geographic lens queries**:
```python
# worker/wikidata/populate_place_context.py
"""
For each important place in xyzo_entities:
1. Look up geographic hierarchy via P131 chain
2. Count related entities via P276/P150 relationships
3. Compute XYZO coverage vs expected coverage
4. Calculate news_desert_score

Run:
    python3 -m worker.wikidata.populate_place_context --limit 10000
"""
```

---

## Phase 3: Intelligence (Build XYZO's "World Model")

### 3.1 Property Observatory
**Status**: ❌ Does not exist

```sql
CREATE TABLE xyzo_property_observatory (
    property_id     TEXT PRIMARY KEY,           -- P31, P17, etc.
    property_label  TEXT,
    statement_count BIGINT,
    distinct_subjects BIGINT,
    distinct_objects BIGINT,

    -- Geographic relevance
    geographic_rate DOUBLE PRECISION,           -- % of claims with geo component
    temporal_rate  DOUBLE PRECISION,           -- % of claims with time qualifier
    reference_rate DOUBLE PRECISION,           -- % of claims with references

    -- XYZO usefulness
    xyzou_sefulness_score DOUBLE PRECISION,     -- computed score
    xyzou_value    TEXT,                       -- 'entity_classification', 'geography', etc.

    last_updated   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_xyzo_prop_score ON xyzo_property_observatory(xyzou_sefulness_score DESC);
```

### 3.2 Coverage Gap Detection
**Status**: ⚠️ `news_source_coverage_gaps` exists but underused

```python
# worker/wikidata/coverage_gap_detector.py
"""
For each xyzo_place_context with high news_desert_score:
1. Identify nearby covered places
2. Find the delta: what institutions exist but aren't covered
3. Generate source recommendations

Coverage anomaly formula:
    entity_richness = pop + institutions + economic + geographic
    expected_coverage = entity_richness × base_rate
    actual_coverage = xyz_article_count
    gap = expected_coverage - actual_coverage

If gap > threshold AND news_desert_score > 0.8:
    → Flag as coverage gap
    → Generate source discovery candidates
"""
```

### 3.3 Wikidata-First Source Discovery
**Status**: ❌ Not implemented

```python
# worker/wikidata/source_discovery.py
"""
Use Wikidata to discover first-party news sources.

For a coverage gap in Place X:
1. Wikidata says: University Y, Hospital Z, Airport A exist there
2. Look up their P856 (official website) values
3. Check if website has RSS/Atom feed
4. Submit to feed_submissions for evaluation

This finds local sources BEFORE Reuters/CNN covers them.
"""
```

### 3.4 News Gravity Field
**Status**: ❌ Not implemented

```sql
CREATE TABLE xyzo_news_gravity (
    entity_qid      TEXT PRIMARY KEY,
    entity_name     TEXT,

    -- Gravity components
    population_score    DOUBLE PRECISION,
    institution_score  DOUBLE PRECISION,
    economic_score     DOUBLE PRECISION,
    geographic_score   DOUBLE PRECISION,

    -- Current activity
    news_velocity      DOUBLE PRECISION,   -- articles/day (7-day avg)
    event_count        INTEGER,
    source_diversity   INTEGER,           -- unique sources

    -- Computed
    expected_attention DOUBLE PRECISION,    -- gravity_components × weight
    actual_attention   DOUBLE PRECISION,   -- news_velocity × source_diversity
    gravity_ratio      DOUBLE PRECISION,   -- actual / expected

    -- Classification
    gravity_state  TEXT,   -- '🔥_emerging', '🕳_undercovered', '🌱_quiet_but_important', '⚡_rapidly_changing', '🌐_globally_connected'

    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_xyzo_gravity_state ON xyzo_news_gravity(gravity_state);
CREATE INDEX idx_xyzo_gravity_ratio ON xyzo_news_gravity(gravity_ratio);
```

---

## Phase 4: Advanced (Time-Series & Graph Intelligence)

### 4.1 Time-Series Graph Change Tracking
**Status**: ❌ Not implemented

```sql
CREATE TABLE xyzo_entity_history (
    id              BIGSERIAL PRIMARY KEY,
    entity_qid      TEXT NOT NULL,
    predicate       TEXT NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    change_type     TEXT,           -- 'added', 'removed', 'changed', 'rank_change'
    qualifiers      JSONB,
    sources         JSONB,          -- reference URLs
    change_date     TIMESTAMPTZ,

    -- XYZO relevance
    news_relevance  DOUBLE PRECISION DEFAULT 0,
    detected_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_xyzo_history_entity ON xyzo_entity_history(entity_qid);
CREATE INDEX idx_xyzo_history_date ON xyzo_entity_history(change_date DESC);
```

### 4.2 Graph-Connected Event Detection
**Status**: ❌ Not implemented

```python
# worker/wikidata/graph_event_detector.py
"""
Gemma asks:
"These 37 articles concern entities connected through this Wikidata graph.
What new relationship appears to be emerging?"

1. Collect articles → extract entity QIDs
2. Build subgraph: all relationships between these entities
3. Ask Gemma: "What does this graph tell us about what's happening?"
"""
```

---

## Implementation Order

```
Week 1-2: Foundation
├── 1.1 Add wikidata_qid to wiki_articles (bridge)
├── 1.2 Create xyzo_entities table + populate sample
└── 1.3 Create xyzo_entity_relationships table + populate key properties

Week 3-4: Integration
├── 2.1 Build entity resolver (populate news_entities.wikidata_id)
├── 2.2 Replace keyword guessing with P31 type verification
└── 2.3 Build xyzo_place_context

Week 5-6: Intelligence
├── 3.1 Property Observatory
├── 3.2 Coverage gap detection
└── 3.3 Source discovery

Week 7+: Advanced
├── 4.1 Time-series tracking
└── 4.2 Graph event detection
```

---

## File Structure

```
worker/wikidata/
├── __init__.py
├── populate_xyzo_entities.py      # Phase 1.2
├── populate_xyzo_relationships.py # Phase 1.3
├── wiki_wikidata_bridge.py       # Phase 1.1
├── resolve_wikidata_entities.py   # Phase 2.1
├── entity_type_verifier.py        # Phase 2.2
├── populate_place_context.py      # Phase 2.3
├── property_observatory.py       # Phase 3.1
├── coverage_gap_detector.py       # Phase 3.2
├── source_discovery.py            # Phase 3.3
├── news_gravity.py                # Phase 3.4
├── entity_history_tracker.py      # Phase 4.1
├── graph_event_detector.py        # Phase 4.2
└── README.md                       # Documentation
```

---

## Critical Constraints

1. **Don't full-scan 700GB**: Use `TABLESAMPLE`, estimates, and batch processing
2. **Autovacuum is OFF on wd_entities**: Don't run `ANALYZE` or `VACUUM` on production Wikidata DB
3. **Respect Wikidata dumps cadence**: Full dumps weekly, JSON daily — sync strategy needed
4. **Gemma is for questions, not database**: Use SQL/PostGIS/classical ML before reaching for LLM
5. **Privacy matters**: `news_entities.wikidata_id` links personal data — handle appropriately

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Entity resolution rate | >80% of news_entities have wikidata_id |
| Coverage gap detection | >100 high-confidence gaps identified |
| Source discovery | >10 new local sources discovered per month |
| Place context coverage | Top 10,000 cities have xyzo_place_context |
| Graph event detection | Gemma receives <100 entity context per query (avoid token bloat) |
