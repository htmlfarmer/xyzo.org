# Xyzo Quality Engine — Comprehensive Specification

**Status**: Draft
**Last Updated**: 2026-09-01
**Priority**: P0 — Data Quality | P1 — Training System | P2 — NN Architecture | P3 — Personalization

---

## Table of Contents

1. [Priority 1: Data Quality Engine](#priority-1-data-quality-engine)
   - 1.1 [Location Confidence Engine](#11-location-confidence-engine)
   - 1.2 [Source Intelligence](#12-source-intelligence)
   - 1.3 [Country Intelligence](#13-country-intelligence)
2. [Priority 2: Training & Labeling System](#priority-2-training--labeling-system)
   - 2.1 [NN Laboratory Admin UI](#21-nn-laboratory-admin-ui)
   - 2.2 [Labeling Interfaces](#22-labeling-interfaces)
   - 2.3 [Coverage Model Fix](#23-coverage-model-fix)
   - 2.4 [ML Scoreboard](#24-ml-scoreboard)
3. [Priority 3: Operational Loop](#priority-3-operational-loop)
   - 3.1 [Automatic Learning Loop](#31-automatic-learning-loop)
   - 3.2 [Event Timelines](#32-event-timelines)
   - 3.3 [Intelligence Cards](#33-intelligence-cards)
   - 3.4 [Semantic Search](#34-semantic-search)
4. [Priority 4: Source & Event Expansion](#priority-4-source--event-expansion)
   - 4.1 [Source Quality Intelligence](#41-source-quality-intelligence)
   - 4.2 [Source Expansion](#42-source-expansion)
   - 4.3 [Non-News Event Feeds](#43-non-news-event-feeds)
5. [Priority 5: NN Architecture](#priority-5-nn-architecture)
   - 5.1 [Embedding Dimension Benchmarking](#51-embedding-dimension-benchmarking)
   - 5.2 [Personalized News Ranking](#52-personalized-news-ranking)
6. [Priority 6: Security & Operational Reliability](#priority-6-security--operational-reliability)
7. [Implementation Phases](#implementation-phases)
8. [Test Plan](#test-plan)

---

## Priority 1: Data Quality Engine

### 1.1 Location Confidence Engine

Every article row in `news_articles` gets a complete location metadata block. The `location_confidence` column becomes a JSONB object rather than a single float.

#### Schema Changes

```sql
-- New table: article location audit trail
CREATE TABLE news_article_locationCandidates (
    id              BIGSERIAL PRIMARY KEY,
    article_id      BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    location_text   TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    precision       TEXT NOT NULL CHECK (precision IN (
                        'exact_building','street','neighborhood',
                        'city','county','state','country','regional','unknown'
                    )),
    confidence      DOUBLE PRECISION NOT NULL,  -- 0.0 to 1.0
    source          TEXT NOT NULL CHECK (source IN (
                        'ai_extraction','nominatim','user_feedback',
                        'wikipedia','classify','cluster','default'
                    )),
    method          TEXT NOT NULL CHECK (method IN (
                        'gemma4','regex','city_match','entity_lookup',
                        'gazetteer','title_parse','dateline','source_country'
                    )),
    reasons         TEXT[],  -- e.g. ['wikipedia_geo_tag', 'city_name_in_title']
    ranked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(article_id, location_text, source, method)
);

-- Index for fast candidate lookup
CREATE INDEX idx_locationCandidates_article ON news_article_locationCandidates(article_id);
CREATE INDEX idx_locationCandidates_confidence ON news_article_locationCandidates(article_id, confidence DESC);

-- Add location metadata JSONB column
ALTER TABLE news_articles ADD COLUMN location_metadata JSONB;

-- Update location_metadata structure:
-- {
--   "chosen": {
--     "location_text": "Dhaka, Bangladesh",
--     "lat": 23.8103,
--     "lng": 90.4125,
--     "precision": "city",
--     "confidence": 0.94,
--     "source": "ai_extraction",
--     "method": "gemma4",
--     "reasons": ["city_name_match", "population_rank"],
--     "alternatives_count": 4,
--     "disputed": false
--   },
--   "candidates": [1, 2, 3, 4],  -- FKs to locationCandidates
--   "geocoder_used": "nominatim",
--   "geocoder_latency_ms": 42,
--   "total_candidates": 4,
--   "low_confidence_flag": false,
--   "needs_review": false
-- }
```

#### Precision Levels (strict enum)

| Value | Description | Example |
|---|---|---|
| `exact_building` | Specific named building or landmark | "Banani General Hospital, Dhaka" |
| `street` | Street-level location | "Kamal Ataturk Road, Chittagong" |
| `neighborhood` | Named neighborhood within a city | "Gulshan, Dhaka" |
| `city` | City-level (default for most articles) | "Dhaka" |
| `county` | County or district | "Dhaka District" |
| `state` | State or province | "Dhaka Division" |
| `country` | Country-level only | "Bangladesh" |
| `regional` | Multi-country region | "South Asia", "Middle East" |
| `unknown` | No location determinable | — |

#### Confidence Score Formula

```
location_confidence = w1×geocoder_confidence
                    + w2×precision_weight
                    + w3×entity_match_score
                    + w4×population_rank_score
                    + w5×source_reliability

where:
  geocoder_confidence = 0.8 (nominatim) or 0.9 (gemma4)
  precision_weight    = {exact_building:1.0, street:0.9, neighborhood:0.8, city:0.7, county:0.6, state:0.5, country:0.4, regional:0.3, unknown:0.0}
  entity_match_score  = 1.0 if entity detected, else 0.5
  population_rank_score = 1.0 if top-100 city, 0.8 if top-1000, 0.5 otherwise
  source_reliability  = news_sources.reliability_score / 10.0
```

#### Pipeline Integration

In `worker/extract.py`, after AI extraction:
1. Store all N candidate locations in `news_article_locationCandidates`
2. Pick the highest-confidence candidate as the primary `location_id`
3. Write the complete `location_metadata` JSONB to `news_articles`

In `worker/geocode.py`:
1. If AI produced candidates, verify each with Nominatim
2. Store verification result as a candidate with `source='user_feedback'` not applicable
3. Add `source_country` as fallback candidate with `precision='country'`, `confidence=0.3`

#### Disputed Location Handling

If two candidates from different countries have similar confidence:
- Set `chosen.disputed = true` in `location_metadata`
- Flag `needs_review = true`
- Show in `/admin/nn/labels` geolocation review queue

#### Tests

```python
# worker/tests/test_location_quality.py

def test_precision_enum_values():
    """Only valid precision values are accepted"""
    valid = {'exact_building','street','neighborhood','city','county',
              'state','country','regional','unknown'}
    for v in valid:
        assert is_valid_precision(v)

def test_confidence_range_0_to_1():
    """Confidence scores are always between 0 and 1"""
    for row in fetch_all_articles():
        meta = row.location_metadata or {}
        chosen = meta.get('chosen', {})
        assert 0.0 <= chosen.get('confidence', -1) <= 1.0

def test_candidates_table_populated():
    """Every extracted article has at least one candidate"""
    articles = fetch_articles(status='extracted', since='2026-09-01')
    for a in articles:
        candidates = fetch_candidates(a.id)
        assert len(candidates) >= 1, f"article {a.id} has no location candidates"

def test_precision_determinable():
    """Every chosen location has a non-unknown precision"""
    articles = fetch_all_articles()
    for a in articles:
        meta = a.location_metadata or {}
        chosen = meta.get('chosen', {})
        assert chosen.get('precision') != 'unknown', f"article {a.id} precision is unknown"

def test_low_confidence_flag():
    """Articles with confidence < 0.5 are flagged"""
    articles = fetch_articles(status='extracted', since='2026-09-01')
    for a in articles:
        meta = a.location_metadata or {}
        chosen = meta.get('chosen', {})
        conf = chosen.get('confidence', 1.0)
        assert meta.get('low_confidence_flag') == (conf < 0.5)

def test_location_metadata_jsonb_structure():
    """location_metadata has required keys"""
    required_keys = {'chosen', 'candidates', 'geocoder_used',
                     'total_candidates', 'low_confidence_flag', 'needs_review'}
    for a in fetch_all_articles():
        meta = a.location_metadata or {}
        assert required_keys.issubset(meta.keys()), f"article {a.id} missing keys in location_metadata"

def test_disputed_locations_flagged():
    """Cross-border candidate pairs with similar confidence are flagged disputed"""
    for a in fetch_all_articles():
        meta = a.location_metadata or {}
        candidates = [get_candidate(c) for c in meta.get('candidates', [])]
        cross_border = [(c1, c2) for c1 in candidates for c2 in candidates
                        if c1.country != c2.country and
                           abs(c1.confidence - c2.confidence) < 0.1]
        if cross_border:
            assert meta.get('chosen', {}).get('disputed') == True
```

---

### 1.2 Source Intelligence

Every source gets a rich metadata profile beyond just `reliability_score`.

#### Schema Changes

```sql
-- Add columns to news_sources
ALTER TABLE news_sources ADD COLUMN political_leaning    TEXT;  -- left, center-left, center, center-right, right, unknown
ALTER TABLE news_sources ADD COLUMN geographic_bias     TEXT;  -- local, regional, national, international
ALTER TABLE news_sources ADD COLUMN primary_topics       TEXT[];
ALTER TABLE news_sources ADD COLUMN primary_entities     TEXT[];  -- most-covered named entities
ALTER TABLE news_sources ADD COLUMN language_primary     TEXT;
ALTER TABLE news_sources ADD COLUMN language_secondary  TEXT[];
ALTER TABLE news_sources ADD COLUMN avg_article_latency_seconds  INTEGER;  -- publish time vs event time
ALTER TABLE news_sources ADD COLUMN correction_count     INTEGER DEFAULT 0;
ALTER TABLE news_sources ADD COLUMN correction_rate     DOUBLE PRECISION DEFAULT 0.0;  -- corrections / total articles
ALTER TABLE news_sources ADD COLUMN duplicate_rate      DOUBLE PRECISION DEFAULT 0.0;  -- duplicate_of other source / total
ALTER TABLE news_sources ADD COLUMN location_accuracy_score DOUBLE PRECISION DEFAULT 0.5;
ALTER TABLE news_sources ADD COLUMN citation_quality    DOUBLE PRECISION DEFAULT 0.5;  -- 0-1
ALTER TABLE news_sources ADD COLUMN first_report_count   INTEGER DEFAULT 0;  -- articles where this was the first source
ALTER TABLE news_sources ADD COLUMN original_reporting_ratio DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE news_sources ADD COLUMN coverage_score      DOUBLE PRECISION DEFAULT 0.5;
ALTER TABLE news_sources ADD COLUMN user_feedback_score DOUBLE PRECISION DEFAULT 0.5;  -- from nn_user_corrections
ALTER TABLE news_sources ADD COLUMN last_evaluated_at   TIMESTAMPTZ;
ALTER TABLE news_sources ADD COLUMN source_profile      JSONB;  -- full structured profile

-- Indexes
CREATE INDEX idx_sources_country ON news_sources(country);
CREATE INDEX idx_sources_language ON news_sources(language_primary);
CREATE INDEX idx_sources_reliability ON news_sources(reliability_score DESC);
```

#### Source Profile JSONB Structure

```json
{
  "source_id": 123,
  "evaluated_at": "2026-09-01T12:00:00Z",
  "summary": {
    "reliability": 0.87,
    "speed": 0.72,
    "accuracy": 0.91,
    "original_reporting": 0.65,
    "location_accuracy": 0.88,
    "overall": 0.81
  },
  "geographic_reach": {
    "primary_country": "BD",
    "secondary_countries": ["IN", "PK", "MM"],
    "coverage_score": 0.78
  },
  "topic_expertise": [
    {"topic": "politics", "score": 0.92, "article_count": 1847},
    {"topic": "economy",  "score": 0.74, "article_count": 943},
    {"topic": "disaster", "score": 0.88, "article_count": 312}
  ],
  "entity_network": [
    {"entity": "Sheikh Hasina", "mentions": 847, "first_covered": "2024-01-15"},
    {"entity": "BNP",          "mentions": 623, "first_covered": "2024-01-20"}
  ],
  "speed_profile": {
    "avg_latency_seconds": 1847,
    "fastest_articles": [
      {"event_type": "earthquake", "latency_seconds": 120},
      {"event_type": "protest",    "latency_seconds": 340}
    ]
  },
  "quality_signals": {
    "correction_rate": 0.012,
    "duplicate_rate": 0.08,
    "first_report_count": 23,
    "original_reporting_ratio": 0.34
  },
  "citation_graph": {
    "cited_by": [234, 567, 890],
    "cites": [111, 222]
  },
  "story_overlap": {
    "shared_events_with": {234: 0.78, 567: 0.45},
    "avg_overlap_ratio": 0.31
  }
}
```

#### Source Quality Score Formula

```python
def compute_source_quality_score(source_id: int) -> float:
    s = get_source(source_id)
    w = {
        'reliability':      0.25,
        'accuracy':         0.20,
        'speed':            0.10,
        'original_reporting': 0.15,
        'correction_rate':  0.10,   # inverse: lower is better
        'location_accuracy': 0.10,
        'user_feedback':    0.10,
    }
    score = (
        w['reliability']      * (s.reliability_score / 10.0) +
        w['accuracy']         * s.accuracy_score +
        w['speed']            * (1.0 - min(s.avg_article_latency_seconds / 86400, 1.0)) +
        w['original_reporting'] * s.original_reporting_ratio +
        w['correction_rate']  * (1.0 - s.correction_rate) +
        w['location_accuracy'] * s.location_accuracy_score +
        w['user_feedback']   * s.user_feedback_score
    )
    return round(score, 3)
```

#### Tests

```python
# worker/tests/test_source_quality.py

def test_source_profile_jsonb_structure():
    """Every active source has a well-formed profile"""
    for s in fetch_active_sources():
        p = s.source_profile or {}
        assert 'summary' in p
        assert 'geographic_reach' in p
        assert 'topic_expertise' in p
        assert 0 <= p['summary']['overall'] <= 1

def test_source_quality_score_range():
    """Quality scores are between 0 and 1"""
    for s in fetch_active_sources():
        score = compute_source_quality_score(s.id)
        assert 0.0 <= score <= 1.0, f"source {s.id} score {score} out of range"

def test_topic_expertise_top_5():
    """Each source lists at most 5 primary topics"""
    for s in fetch_active_sources():
        topics = s.primary_topics or []
        assert len(topics) <= 5

def test_citation_graph_bidirectional():
    """If A cites B, B's cited_by includes A"""
    for s in fetch_active_sources():
        profile = s.source_profile or {}
        cited_by = set(profile.get('citation_graph', {}).get('cited_by', []))
        for other_id in profile.get('citation_graph', {}).get('cites', []):
            other = get_source(other_id)
            other_cited_by = set(other.source_profile.get('citation_graph', {}).get('cited_by', []))
            assert s.id in other_cited_by, f"citation {s.id} -> {other_id} not reciprocated"

def test_story_overlap_symmetric():
    """Story overlap is symmetric: A's overlap with B == B's overlap with A"""
    for s in fetch_active_sources():
        overlap = s.source_profile or {}
        for other_id, ratio in overlap.get('story_overlap', {}).get('shared_events_with', {}).items():
            other = get_source(other_id)
            other_overlap = other.source_profile or {}
            other_ratio = other_overlap.get('story_overlap', {}).get('shared_events_with', {}).get(s.id, None)
            if other_ratio is not None:
                assert abs(ratio - other_ratio) < 0.01, f"asymmetric overlap {s.id}/{other_id}"

def test_reliability_score_determinable():
    """Every active source has a reliability_score > 0"""
    for s in fetch_active_sources():
        assert s.reliability_score > 0, f"source {s.id} has no reliability score"
```

---

### 1.3 Country Intelligence

Every country gets a comprehensive intelligence profile.

#### Schema Changes

```sql
-- New table: country intelligence profiles
CREATE TABLE nn_country_intelligence (
    country_code     CHAR(2) PRIMARY KEY REFERENCES countries(iso_alpha2),
    country_name     TEXT NOT NULL,
    region           TEXT,
    population       BIGINT,
    gdppc_usd        DOUBLE PRECISION,
    news_volume_24h  INTEGER DEFAULT 0,
    news_volume_7d   INTEGER DEFAULT 0,
    source_count     INTEGER DEFAULT 0,
    local_sources    INTEGER DEFAULT 0,    -- headquartered in country
    international_sources INTEGER DEFAULT 0, -- covering country from outside
    languages_covered TEXT[],               -- ISO 639-1 codes
    language_coverage_score DOUBLE PRECISION DEFAULT 0.0,
    events_24h       INTEGER DEFAULT 0,
    events_7d        INTEGER DEFAULT 0,
    local_source_pct DOUBLE PRECISION DEFAULT 0.0,  -- local / total sources
    intl_source_pct   DOUBLE PRECISION DEFAULT 0.0,
    geographic_coverage_score DOUBLE PRECISION DEFAULT 0.0,
    topic_coverage   JSONB,   -- {"politics": 0.9, "economy": 0.7, ...}
    topic_coverage_score DOUBLE PRECISION DEFAULT 0.0,
    coverage_confidence DOUBLE PRECISION DEFAULT 0.0,
    local_story_pct  DOUBLE PRECISION DEFAULT 0.0,  -- stories originated here vs covered from outside
    first_report_rate DOUBLE PRECISION DEFAULT 0.0,
    avg_source_reliability DOUBLE PRECISION DEFAULT 0.0,
    active_event_count INTEGER DEFAULT 0,
    last_updated     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Materialized view to refresh country intelligence
CREATE MATERIALIZED VIEW mv_country_intelligence AS
SELECT
    c.iso_alpha2,
    c.name,
    c.region,
    c.population,
    c.gdppc_usd,
    COUNT(DISTINCT a.id) FILTER (WHERE a.published_at > now() - INTERVAL '24 hours') AS news_volume_24h,
    COUNT(DISTINCT a.id) FILTER (WHERE a.published_at > now() - INTERVAL '7 days')  AS news_volume_7d,
    COUNT(DISTINCT s.id) AS source_count,
    COUNT(DISTINCT s.id) FILTER (WHERE s.country = c.iso_alpha2) AS local_sources,
    COUNT(DISTINCT s.id) FILTER (WHERE s.country != c.iso_alpha2) AS international_sources,
    ARRAY_AGG(DISTINCT a.language) FILTER (WHERE a.published_at > now() - INTERVAL '7 days') AS languages_covered,
    COUNT(DISTINCT e.id) FILTER (WHERE e.primary_location_id IN (
        SELECT id FROM news_locations WHERE country = c.iso_alpha2
    ) AND e.occurred_at > now() - INTERVAL '24 hours') AS events_24h,
    FROM countries c
    LEFT JOIN news_sources s ON s.country = c.iso_alpha2 AND s.active = true
    LEFT JOIN news_articles a ON a.source_id = s.id
    LEFT JOIN news_events e ON ...
GROUP BY c.iso_alpha2, c.name, c.region, c.population, c.gdppc_usd;

CREATE UNIQUE INDEX ON mv_country_intelligence(iso_alpha2);

-- Indexes
CREATE INDEX idx_countryintel_region ON nn_country_intelligence(region);
CREATE INDEX idx_countryintel_volume ON nn_country_intelligence(news_volume_24h DESC);
CREATE INDEX idx_countryintel_coverage ON nn_country_intelligence(coverage_confidence DESC);
```

#### Country Profile JSONB (`topic_coverage`)

```json
{
  "politics":    0.92,
  "economy":     0.85,
  "disaster":    0.78,
  "conflict":    0.65,
  "sports":      0.95,
  "culture":     0.60,
  "health":      0.70,
  "science":     0.40
}
```

#### Tests

```python
# worker/tests/test_country_intelligence.py

def test_all_iso_countries_have_intelligence_row():
    """Every country in the countries table has a row in nn_country_intelligence"""
    countries = fetch_all_countries()
    for c in countries:
        row = fetch_country_intelligence(c.iso_alpha2)
        assert row is not None, f"country {c.iso_alpha2} missing intelligence row"

def test_population_matches_countries_table():
    """Population in intelligence matches countries table"""
    for c in fetch_all_countries():
        intel = fetch_country_intelligence(c.iso_alpha2)
        assert intel.population == c.population

def test_news_volume_24h_non_negative():
    """News volume is never negative"""
    for row in fetch_all_country_intelligence():
        assert row.news_volume_24h >= 0
        assert row.news_volume_7d >= 0

def test_local_intl_sources_sum_to_total():
    """local_sources + international_sources == source_count"""
    for row in fetch_all_country_intelligence():
        assert row.local_sources + row.international_sources == row.source_count

def test_language_coverage_score_range():
    """Language coverage score is between 0 and 1"""
    for row in fetch_all_country_intelligence():
        assert 0.0 <= row.language_coverage_score <= 1.0

def test_topic_coverage_jsonb_valid():
    """topic_coverage JSONB has valid topic names and scores"""
    valid_topics = {'politics','economy','disaster','conflict','sports',
                     'culture','health','science','technology','environment'}
    for row in fetch_all_country_intelligence():
        tc = row.topic_coverage or {}
        for topic, score in tc.items():
            assert topic in valid_topics, f"unknown topic: {topic}"
            assert 0.0 <= score <= 1.0, f"score {score} out of range for {topic}"

def test_country_intelligence_refreshed_within_1h():
    """No intelligence row is older than 1 hour"""
    for row in fetch_all_country_intelligence():
        age_seconds = (now() - row.last_updated).total_seconds()
        assert age_seconds < 3600, f"country {row.country_code} intelligence is {age_seconds}s old"
```

---

## Priority 2: Training & Labeling System

### 2.1 NN Laboratory Admin UI

New route: `GET /admin/nn` — NN model laboratory dashboard.

#### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/nn/models` | All 7 models with lifecycle, version, metrics |
| `GET` | `/api/admin/nn/models/:name` | Single model detail |
| `GET` | `/api/admin/nn/models/:name/labels` | Paginated labels for a model |
| `GET` | `/api/admin/nn/queue` | Labeling work queue (articles needing labels) |
| `POST` | `/api/admin/nn/labels` | Submit a label (correction) |
| `GET` | `/api/admin/nn/scoreboard` | ML metrics for all models |
| `GET` | `/api/admin/nn/drift` | Drift per model since last training |
| `POST` | `/api/admin/nn/models/:name/train` | Trigger training for a model |
| `POST` | `/api/admin/nn/models/:name/promote` | Set model version to is_active=true |
| `POST` | `/api/admin/nn/models/:name/rollback` | Deactivate current, revert to previous |

#### Model Status Response

```json
{
  "name": "event_matching",
  "version": "v3",
  "lifecycle": "live",
  "trained_at": "2026-08-28T14:23:00Z",
  "labeled_rows": 847,
  "total_rows": 5000,
  "metrics": {
    "accuracy": 0.91,
    "precision": 0.88,
    "recall": 0.94,
    "f1": 0.91,
    "calibration": 0.93,
    "latency_ms_p50": 2.3,
    "latency_ms_p99": 8.7,
    "throughput_per_sec": 4123,
    "drift_score": 0.03,
    "false_positive_rate": 0.08,
    "false_negative_rate": 0.06,
    "confusion_matrix": [[890, 110], [60, 940]]
  },
  "dataset_version": "ds_abc123",
  "trained_by": "automated",
  "deployment": {
    "is_active": true,
    "since": "2026-08-28T15:00:00Z",
    "prediction_count": 142857,
    "error_count": 23
  }
}
```

### 2.2 Labeling Interfaces

#### 2.2.1 Event Matching Labels

**UI Flow:**
1. Fetch pair of articles (`article_a_id`, `article_b_id`) from `nn_inference_queue` where `model_name='event_matching'` and `status='needs_label'`
2. Display both articles side-by-side
3. User chooses: YES / NO / UNCERTAIN
4. Submit to `POST /api/admin/nn/labels`

```json
// POST /api/admin/nn/labels
{
  "model_name": "event_matching",
  "article_a_id": 12345,
  "article_b_id": 67890,
  "label": "yes",  // "yes" | "no" | "uncertain"
  "session_id": "admin_123",
  "confidence": "high"  // "high" | "medium" | "low"
}
```

#### 2.2.2 Geolocation Labels

**UI Flow:**
1. Fetch article with `location_metadata.needs_review=true` or random sample from `news_article_locationCandidates`
2. Display article text + predicted location
3. Show top-5 candidate alternatives from `news_article_locationCandidates`
4. Admin selects correct candidate or enters freeform correction

```json
// POST /api/admin/nn/labels
{
  "model_name": "geolocation",
  "article_id": 12345,
  "label": {
    "location_text": "Chittagong, Bangladesh",
    "lat": 22.3569,
    "lng": 91.7832,
    "precision": "city"
  },
  "alternatives_considered": [2, 3, 4, 5],
  "corrected_candidate_id": 3
}
```

#### 2.2.3 Entity Extraction Labels

**UI Flow:**
1. Show article text with detected entities highlighted
2. Show detected entities in a panel
3. Admin can add missing entities, remove wrong ones, fix types
4. Relationships shown as graph: admin confirms or corrects edges

```json
// POST /api/admin/nn/labels
{
  "model_name": "entity_extraction",
  "article_id": 12345,
  "entities": [
    {"text": "Donald Trump", "type": "PERSON", "start": 0, "end": 13, "correct": true},
    {"text": "Apple", "type": "ORG", "start": 25, "end": 30, "correct": true},
    {"text": "Tim Cook", "type": "PERSON", "start": 35, "end": 42, "correct": false, "corrected_type": "PERSON"},
    {"text": "Washington", "type": "LOCATION", "start": 50, "end": 60, "correct": false, "corrected_type": "LOCATION"}
  ],
  "relationships": [
    {"from": "Donald Trump", "to": "Tim Cook", "type": "met", "correct": true},
    {"from": "Apple", "to": "Tim Cook", "type": "led_by", "correct": true}
  ]
}
```

#### 2.2.4 Relationship Labels

```json
// POST /api/admin/nn/labels
{
  "model_name": "relationship",
  "entity_pair": {
    "entity_1": {"text": "Sheikh Hasina", "type": "PERSON"},
    "entity_2": {"text": "Bangladesh Awami League", "type": "ORG"}
  },
  "label": "leads",
  "confidence": "high"
}
```

#### Label Validation Tests

```python
# worker/tests/test_labeling.py

def test_label_requires_model_name():
    """Labels without model_name are rejected"""
    r = submit_label({"article_id": 123})
    assert r.status == 400

def test_label_requires_valid_model():
    """Labels for unknown models are rejected"""
    r = submit_label({"model_name": "nonexistent", "article_id": 123})
    assert r.status == 400

def test_event_match_labels_need_two_articles():
    """event_matching labels need both article_a_id and article_b_id"""
    r = submit_label({"model_name": "event_matching", "article_a_id": 1})
    assert r.status == 400

def test_yes_no_uncertain_enum():
    """event_matching labels must be yes/no/uncertain"""
    for label in ["yes", "no", "uncertain"]:
        r = submit_label({"model_name": "event_matching",
                          "article_a_id": 1, "article_b_id": 2, "label": label})
        assert r.status == 200
    r = submit_label({"model_name": "event_matching",
                       "article_a_id": 1, "article_b_id": 2, "label": "maybe"})
    assert r.status == 400

def test_geolocation_label_has_location():
    """geolocation labels must include location_text"""
    r = submit_label({"model_name": "geolocation", "article_id": 1, "label": {}})
    assert r.status == 400

def test_entity_extraction_label_has_entities():
    """entity_extraction labels must include entities array"""
    r = submit_label({"model_name": "entity_extraction", "article_id": 1, "entities": []})
    assert r.status == 400

def test_label_written_to_nn_user_corrections():
    """Valid label is stored in nn_user_corrections"""
    submit_label({"model_name": "event_matching", "article_a_id": 1,
                  "article_b_id": 2, "label": "yes"})
    row = db.query("SELECT * FROM nn_user_corrections ORDER BY created_at DESC LIMIT 1")
    assert row.model_name == "event_matching"
    assert row.correction_type == "event_match_yes"

def test_uncertain_label_flags_for_review():
    """Uncertain labels set needs_review=true on the article"""
    article_id = 123
    submit_label({"model_name": "event_matching",
                  "article_a_id": article_id, "article_b_id": 2,
                  "label": "uncertain"})
    article = get_article(article_id)
    assert article.needs_review == True

def test_100_labels_enables_training():
    """100+ labels for a model changes status from cold_start"""
    set_labels_count("event_matching", 100)
    status = get_model_status("event_matching")
    assert status['lifecycle'] == "ready_to_train"
```

### 2.3 Coverage Model Fix

The `infer_coverage()` in `nn_infer.py` and `extract_coverage()` in `nn_features.py` use placeholder 0s because `country_regions` and `world_cities` tables don't exist in expected form. Fix by querying the actual FDW schema.

#### Actual Schema References

```python
# worker/nn_features.py — FIX extract_coverage()

def extract_coverage(db, model_name="coverage"):
    """
    Fixed coverage features using actual FDW schema:
    - xyzo_cities.world_cities (via FDW) for population + lat/lng
    - news_sources for active source counts
    - news_articles for volume
    - countries table for gdppc
    """

    rows = db.unsafe("""
        WITH country_stats AS (
            SELECT
                c.iso_alpha2 AS country_code,
                c.name        AS country_name,
                c.region,
                c.population,
                COALESCE(c.gdppc_usd, 0) AS gdppc_usd,
                COUNT(DISTINCT s.id) FILTER (
                    WHERE s.active = true AND s.country = c.iso_alpha2
                ) AS local_source_count,
                COUNT(DISTINCT s.id) FILTER (
                    WHERE s.active = true AND s.country != c.iso_alpha2
                ) AS intl_source_count,
                COUNT(DISTINCT a.id) FILTER (
                    WHERE a.published_at > now() - INTERVAL '24 hours'
                    AND a.source_id IN (
                        SELECT id FROM news_sources WHERE country = c.iso_alpha2
                    )
                ) AS articles_24h,
                COUNT(DISTINCT e.id) FILTER (
                    WHERE e.occurred_at > now() - INTERVAL '24 hours'
                    AND e.primary_location_id IN (
                        SELECT id FROM news_locations WHERE country = c.iso_alpha2
                    )
                ) AS events_24h
            FROM countries c
            LEFT JOIN news_sources s ON s.country = c.iso_alpha2
            LEFT JOIN news_articles a ON a.source_id IN (
                SELECT id FROM news_sources WHERE country = c.iso_alpha2
            )
            LEFT JOIN news_events e ON e.primary_location_id IN (
                SELECT id FROM news_locations WHERE country = c.iso_alpha2
            )
            WHERE c.iso_alpha2 NOT IN ('XX', 'XG', 'XT')  -- exclude placeholder codes
            GROUP BY c.iso_alpha2, c.name, c.region, c.population, c.gdppc_usd
        ),
        neighboring_gaps AS (
            SELECT
                c.iso_alpha2,
                ARRAY_AGG(cs.gap_score ORDER BY cs.gap_score DESC) AS neighbor_gaps
            FROM countries c
            JOIN country_borders cb ON cb.country_code = c.iso_alpha2
            JOIN country_stats cs ON cs.country_code = cb.neighbor_code
            GROUP BY c.iso_alpha2
        ),
        coverage AS (
            SELECT
                cs.*,
                ng.neighbor_gaps,
                CASE WHEN cs.population > 0
                    THEN LEAST(cs.articles_24h::float / (cs.population / 1_000_000), 10.0)
                    ELSE 0
                END AS articles_per_million_24h,
                CASE WHEN cs.population > 0
                    THEN LEAST(cs.events_24h::float / (cs.population / 1_000_000), 5.0)
                    ELSE 0
                END AS events_per_million_24h,
                CASE WHEN cs.local_source_count + cs.intl_source_count > 0
                    THEN cs.local_source_count::float
                          / (cs.local_source_count + cs.intl_source_count)
                    ELSE 0
                END AS local_source_pct,
                -- Classical gap score: high population, low sources, low volume
                GREATEST(0,
                    LN(GREATEST(cs.population, 1)) * 0.3
                    - LN(GREATEST(cs.local_source_count + cs.intl_source_count, 1)) * 0.4
                    - LN(GREATEST(cs.articles_24h + 1, 1)) * 0.3
                ) AS gap_score
            FROM country_stats cs
            LEFT JOIN neighboring_gaps ng ON ng.iso_alpha2 = cs.iso_alpha2
        )
        SELECT
            country_code,
            country_name,
            region,
            population,
            gdppc_usd,
            local_source_count + intl_source_count AS total_sources,
            local_source_count,
            intl_source_count,
            articles_24h,
            events_24h,
            articles_per_million_24h,
            events_per_million_24h,
            local_source_pct,
            gap_score,
            COALESCE(neighbor_gaps, ARRAY[]::float[]) AS neighboring_gap_scores
        FROM coverage
        ORDER BY gap_score DESC
    """)
    return rows
```

**Note:** Requires `country_borders` table (adjacency list of countries) which should be added to the cities schema or loaded from a standard borders dataset (Natural Earth).

#### Country Borders Table

```sql
-- Add to cities_schema.sql or a new migration
CREATE TABLE country_borders (
    country_code   CHAR(2) NOT NULL,
    neighbor_code  CHAR(2) NOT NULL,
    border_length_km FLOAT,
    PRIMARY KEY (country_code, neighbor_code)
);

-- Load from Natural Earth data (admin-0 border lengths)
-- This is a one-time setup; can be seeded from a GeoJSON file
```

#### Tests

```python
# worker/tests/test_coverage_features.py

def test_coverage_features_all_countries():
    """Every country in countries table has coverage features"""
    countries = fetch_all_countries()
    features = extract_coverage(db)
    country_codes = {f.country_code for f in features}
    for c in countries:
        if c.iso_alpha2 not in ('XX', 'XG', 'XT'):
            assert c.iso_alpha2 in country_codes, f"missing coverage for {c.iso_alpha2}"

def test_gap_score_non_negative():
    """gap_score is always >= 0"""
    for f in extract_coverage(db):
        assert f.gap_score >= 0, f"negative gap_score for {f.country_code}"

def test_neighbor_gaps_max_8():
    """No country has more than 8 neighbor gap scores"""
    for f in extract_coverage(db):
        assert len(f.neighboring_gap_scores or []) <= 8

def test_local_source_pct_0_to_1():
    """local_source_pct is between 0 and 1"""
    for f in extract_coverage(db):
        assert 0.0 <= f.local_source_pct <= 1.0

def test_articles_per_million_reasonable():
    """articles_per_million_24h is capped at 10"""
    for f in extract_coverage(db):
        assert f.articles_per_million_24h <= 10.0

def test_coverage_features_stable():
    """Running extract_coverage twice produces identical results"""
    f1 = extract_coverage(db)
    f2 = extract_coverage(db)
    assert len(f1) == len(f2)
    for a, b in zip(sorted(f1, key=lambda x: x.country_code),
                    sorted(f2, key=lambda x: x.country_code)):
        assert a.gap_score == b.gap_score
```

### 2.4 ML Scoreboard

Every model tracks metrics over time. Schema addition:

```sql
ALTER TABLE nn_model_registry ADD COLUMN metrics_history JSONB DEFAULT '[]'::jsonb;

-- New table: per-prediction logging for metric computation
CREATE TABLE nn_prediction_log (
    id              BIGSERIAL PRIMARY KEY,
    model_name      TEXT NOT NULL,
    model_version   TEXT NOT NULL,
    article_id      BIGINT,
    entity_id       TEXT,
    entity_type     TEXT,
    predicted_score DOUBLE PRECISION,
    predicted_label TEXT,
    confidence      DOUBLE PRECISION,
    latency_ms      DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_predlog_model ON nn_prediction_log(model_name, created_at DESC);
CREATE INDEX idx_predlog_entity ON nn_prediction_log(model_name, entity_id, entity_type);

-- Computed scoreboard view
CREATE VIEW nn_v_scoreboard AS
SELECT
    model_name,
    model_version,
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours') AS predictions_24h,
    AVG(latency_ms) FILTER (WHERE created_at > now() - INTERVAL '24 hours') AS latency_avg_ms,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE created_at > now() - INTERVAL '24 hours') AS latency_p50_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE created_at > now() - INTERVAL '24 hours') AS latency_p99_ms,
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '7 days') AS predictions_7d
FROM nn_prediction_log
GROUP BY model_name, model_version;
```

#### Scoreboard API Response

```json
// GET /api/admin/nn/scoreboard
{
  "generated_at": "2026-09-01T12:00:00Z",
  "models": {
    "event_matching": {
      "version": "v3",
      "status": "live",
      "metrics_24h": {
        "accuracy": 0.91,
        "precision": 0.88,
        "recall": 0.94,
        "f1": 0.91,
        "calibration": 0.93,
        "latency_ms_p50": 2.3,
        "latency_ms_p99": 8.7,
        "throughput_per_sec": 4123,
        "predictions_24h": 48291,
        "drift_score": 0.03,
        "false_positive_rate": 0.08,
        "false_negative_rate": 0.06
      },
      "metrics_7d": { ... },
      "trend": "stable"  // "improving" | "stable" | "degrading"
    }
  }
}
```

---

## Priority 3: Operational Loop

### 3.1 Automatic Learning Loop

The full feedback loop pipeline:

```
INGEST (worker.run)
    │
    ▼
PREDICT (worker.nn_infer)
    │
    ├───► nn_article_leaderboard_live  (ranked articles)
    │
    ▼
PUBLISH (API /api/nn/leaderboard)
    │
    ▼
USER INTERACTION (analytics.log → nn_realtime_session)
    │
    ▼
CORRECTIONS (admin labeling UI → nn_user_corrections)
    │
    ▼
LABEL DATA (100+ per model → cold_start breaks)
    │
    ▼
TRAIN (worker.nn_train --model X)
    │
    ▼
EVALUATE (compute metrics on holdout set)
    │
    ▼
A/B TEST (shadow mode: old vs new model)
    │
    ▼
PROMOTE (is_active = true for winning model)
    │
    ▼
NEW MODEL VERSION (in nn_model_registry)
    │
    └───► back to INGEST
```

#### Implementation: Auto-Training Trigger

```python
# worker/nn_train.py — add auto-training check

def check_auto_train_eligibility(model_name: str, min_labels: int = 100) -> bool:
    """Return True if model should be auto-trained."""
    count = db.value("""
        SELECT COUNT(*) FROM nn_user_corrections
        WHERE model_name = %s AND correction_type != 'uncertain'
    """, model_name)
    current = db.row("""
        SELECT is_active, predictions_in_cache FROM nn_model_registry
        WHERE model_name = %s AND is_active = true
    """, model_name)
    return (
        count >= min_labels and
        (current is None or current['predictions_in_cache'] > 10000)
    )
```

#### Implementation: A/B Testing

```python
# worker/nn_ab.py

def shadow_deploy(model_name: str, new_version: str):
    """Run new model in shadow mode: log predictions but don't write to cache."""
    db.unsafe("""
        INSERT INTO nn_model_shadow_log (model_name, version, article_id, shadow_score, created_at)
        SELECT %s, %s, article_id, predict_%(model_name)s(article_id), now()
        FROM nn_inference_queue
        WHERE model_name = %s AND status = 'pending'
        LIMIT 1000
    """, model_name, new_version, model_name)

def compute_ab_results(model_name: str, version_a: str, version_b: str) -> dict:
    """Compare shadow model B against live model A using logged predictions."""
    pass  # Compare shadow_score vs actual cached score
```

#### Tests

```python
# worker/tests/test_learning_loop.py

def test_auto_train_triggers_at_100_labels():
    """Training becomes eligible at 100 correct labels"""
    set_labels("event_matching", 99)
    assert not check_auto_train_eligibility("event_matching")
    set_labels("event_matching", 100)
    assert check_auto_train_eligibility("event_matching")

def test_uncertain_labels_dont_count():
    """'uncertain' correction type does not count toward training eligibility"""
    add_label("event_matching", article_a=1, article_b=2, label="uncertain", count=200)
    assert not check_auto_train_eligibility("event_matching")

def test_ab_test_compares_scores():
    """Shadow deployment logs both model scores for same article"""
    deploy_shadow("event_matching", "v4")
    run_inference("event_matching")
    shadow_row = db.row("SELECT * FROM nn_model_shadow_log ORDER BY created_at DESC LIMIT 1")
    live_row = db.row("""
        SELECT score FROM nn_prediction_cache
        WHERE model_name = 'event_matching' AND article_id = %s
    """, shadow_row.article_id)
    assert shadow_row.shadow_score is not None
    assert live_row.score is not None

def test_promote_model_sets_is_active():
    """Promoting a model sets is_active=true and others to false"""
    original = get_active_model("event_matching")
    promote_model("event_matching", "v5")
    assert get_active_model("event_matching").version == "v5"
    # Original should no longer be active
    if original and original.version != "v5":
        assert original.is_active == False
```

### 3.2 Event Timelines

Every event gets a timeline of how the story developed across sources.

#### Schema

```sql
CREATE TABLE news_event_timeline (
    id           BIGSERIAL PRIMARY KEY,
    event_id     BIGINT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
    sequence     INTEGER NOT NULL,  -- 1, 2, 3, ...
    occurred_at  TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    source_id    BIGINT REFERENCES news_sources(id),
    source_name  TEXT,
    headline     TEXT,
    summary      TEXT,
    is_local     BOOLEAN DEFAULT false,   -- source country == event country
    is_first     BOOLEAN DEFAULT false,   -- first report globally
    is_govt      BOOLEAN DEFAULT false,   -- government/official source
    language     TEXT,
    url          TEXT,
    UNIQUE(event_id, source_id, published_at)
);

CREATE INDEX idx_timeline_event ON news_event_timeline(event_id, sequence);

-- Populated by: after clustering, for each event's articles sorted by published_at
```

#### Timeline Construction

```python
# worker/event_timeline.py

def build_event_timeline(event_id: int) -> list[dict]:
    """
    Build ordered timeline for an event:
    1. Get event country from primary_location
    2. Get all articles in event, sorted by published_at
    3. Classify each as: first_report, local_source, international_source, govt_statement
    4. Return ordered list
    """
    articles = db.rows("""
        SELECT a.id, a.published_at, a.title, a.summary,
               s.id AS source_id, s.name AS source_name, s.country AS source_country,
               s.language
        FROM news_event_sources es
        JOIN news_articles a ON a.id = es.article_id
        JOIN news_sources s ON s.id = a.source_id
        WHERE es.event_id = %s
        ORDER BY a.published_at ASC
    """, event_id)

    event_country = get_event_country(event_id)
    first_ts = articles[0]['published_at'] if articles else None

    timeline = []
    for i, a in enumerate(articles):
        timeline.append({
            'sequence': i + 1,
            'source_name': a.source_name,
            'published_at': a.published_at,
            'headline': a.title,
            'is_local': a.source_country == event_country,
            'is_first': a.published_at == first_ts if first_ts else False,
            'is_govt': is_government_source(a.source_id),
            'language': a.language,
            'url': f"/api/articles/{a.id}",
        })

    # Bulk insert
    db.unsafe("""
        INSERT INTO news_event_timeline (event_id, sequence, occurred_at, published_at,
            source_id, source_name, headline, is_local, is_first, is_govt, language)
        VALUES (%(event_id)s, %(sequence)s, %(published_at)s, %(published_at)s,
            %(source_id)s, %(source_name)s, %(headline)s,
            %(is_local)s, %(is_first)s, %(is_govt)s, %(language)s)
        ON CONFLICT (event_id, source_id, published_at) DO NOTHING
    """, [{'event_id': event_id, **t} for t in timeline])

    return timeline
```

#### Tests

```python
# worker/tests/test_event_timeline.py

def test_timeline_ordered_by_time():
    """Timeline entries are in chronological order"""
    for event in fetch_active_events():
        tl = get_timeline(event.id)
        for i in range(len(tl) - 1):
            assert tl[i]['published_at'] <= tl[i+1]['published_at']

def test_first_report_flagged():
    """The earliest article in an event is marked is_first=true"""
    for event in fetch_active_events():
        tl = get_timeline(event.id)
        first_reports = [e for e in tl if e['is_first']]
        assert len(first_reports) == 1
        assert tl[0]['is_first'] == True

def test_local_vs_intl_distinguished():
    """local and international sources are correctly flagged"""
    event = get_event_with_country("BD")
    tl = get_timeline(event.id)
    for entry in tl:
        if entry['source_name'] in ['Prothom Alo', 'The Daily Star']:
            assert entry['is_local'] == True

def test_timeline_sequence_continuous():
    """Sequence numbers are 1, 2, 3, ... without gaps"""
    tl = get_timeline(event.id)
    sequences = {e['sequence'] for e in tl}
    assert sequences == set(range(1, len(tl) + 1))

def test_timeline_built_for_all_events():
    """Every active event has at least one timeline entry"""
    for event in fetch_active_events():
        tl = get_timeline(event.id)
        assert len(tl) >= 1, f"event {event.id} has no timeline"
```

### 3.3 Intelligence Cards

Intelligence cards are the UI component shown when clicking a map marker. This is a frontend component backed by new API endpoints.

#### API Response

```json
// GET /api/events/:id/intelligence-card
{
  "event_id": 12345,
  "headline": "Major Earthquake in Japan",
  "event_type": "natural_disaster.earthquake",
  "occurred_at": "2026-09-01T02:14:00Z",
  "last_updated": "2026-09-01T08:42:00Z",
  "confidence": 0.94,
  "importance": 0.91,
  "primary_location": {
    "place_name": " Miyagi Prefecture",
    "country": "JP",
    "lat": 38.27,
    "lng": 141.57
  },
  "timeline": {
    "total_articles": 37,
    "languages": ["en", "ja", "ko", "zh"],
    "first_report": {
      "source": "JMA",
      "published_at": "2026-09-01T02:16:00Z",
      "headline": "Earthquake near Miyagi, M6.2"
    },
    "entries": [
      {"time": "02:16", "source": "JMA", "type": "official", "headline": "..."},
      {"time": "02:31", "source": "NHK", "type": "broadcast", "headline": "..."},
      {"time": "02:58", "source": "Reuters", "type": "international", "headline": "..."}
    ]
  },
  "sources": {
    "total": 37,
    "local": 12,
    "international": 25,
    "top_sources": [
      {"name": "JMA", "type": "official", "reliability": 0.98},
      {"name": "NHK", "type": "broadcast", "reliability": 0.95},
      {"name": "Reuters", "type": "international", "reliability": 0.92}
    ]
  },
  "related": {
    "articles_count": 14,
    "related_events": 3,
    "entities": [
      {"name": "Miyagi Prefecture", "type": "LOCATION", "mentions": 47},
      {"name": "JMA", "type": "ORG", "mentions": 23}
    ]
  }
}
```

### 3.4 Semantic Search

Replace keyword matching with structured semantic queries.

#### Query Parser

```python
# worker/semantic_search.py

"""
Query grammar:
  SEMANTIC_QUERY ::= [INTENT] [ENTITIES] [TIME] [GEO] [EVENT_TYPE]

  INTENT       ::= "show me" | "find" | "what happened" | "latest"
  ENTITIES     ::= entity ("," entity)*
  entity       ::= word+
  TIME         ::= "last N hours|days|weeks" | "since YYYY-MM-DD"
  GEO          ::= "near" PLACE | "in" PLACE | "around" PLACE
  EVENT_TYPE   ::= noun_phrase  -- e.g. "political events" | "earthquakes"

Examples:
  "show me major political events near South Asia last 72 hours"
  → {intent: "show", entities: ["politics"], geo: "South Asia", time: "72h", event_type: "political"}

  "find earthquakes in Japan this week"
  → {intent: "find", entities: [], geo: "Japan", time: "7d", event_type: "earthquake"}
"""

@dataclass
class SemanticQuery:
    intent: str
    entities: list[str]
    time: str          # e.g. "72h", "7d", "since 2026-08-25"
    geo: str
    event_type: str
    importance_min: float = 0.5

def parse_semantic_query(text: str) -> SemanticQuery:
    """Parse natural language into structured query."""
    # Use gemma4 or regex-based parser
    # Falls back to keyword search if parsing fails
    pass
```

#### Semantic Search API

```python
# worker/handlers/semantic_search.py

SEMANTIC_EVENT_TYPES = {
    'earthquake': ['earthquake', 'seismic', 'tremor'],
    'flood': ['flood', 'flooding', 'inundation'],
    'political': ['protest', 'election', 'government', 'diplomatic'],
    'conflict': ['war', 'battle', 'attack', 'clash'],
    'disease': ['outbreak', 'epidemic', 'pandemic'],
    'economic': ['economy', 'gdp', 'inflation'],
}
```

---

## Priority 4: Source & Event Expansion

### 4.1 Source Quality Intelligence

Beyond `reliability_score`, every source gets a multi-dimensional quality profile (already specified in 1.2).

### 4.2 Source Expansion

Target: 1,000+ sources by EOY.

#### Source Discovery Pipeline

```python
# worker/source_discovery.py — add search targets

HIGH_PRIORITY_COUNTRIES = [
    # Sub-Saharan Africa
    'NG', 'KE', 'GH', 'TZ', 'ZA', 'ET', 'UG', 'SN', 'CI', 'CM',
    # South Asia
    'BD', 'PK', 'NP', 'LK', 'MM', 'AF',
    # Southeast Asia
    'ID', 'PH', 'VN', 'TH', 'KH', 'LA', 'MM',
    # Latin America
    'MX', 'CO', 'AR', 'PE', 'VE', 'EC', 'BO', 'PY',
    # Middle East
    'IQ', 'YE', 'JO', 'LB', 'PS', 'YE',
    # Central Asia
    'KZ', 'UZ', 'KG', 'TJ', 'TM',
]

TOPIC_PRIORITIES = ['politics', 'economy', 'disaster', 'conflict', 'health']

def discover_sources_for_country(country_code: str, topic: str, limit: int = 10):
    """
    Search for new RSS feeds for country+topic.
    Uses Google Custom Search API + manual discovery.
    """
    # 1. Search: "{topic} {country} news site:rss"
    # 2. Parse results for feed URLs
    # 3. Validate feed (fetch, parse, check for articles)
    # 4. Score by: has location data, update frequency, reliability signals
    # 5. Store in news_sources with status='pending_validation'
    pass
```

### 4.3 Non-News Event Feeds

Existing JSON sources (USGS, GDELT, NASA EONET) should be expanded and treated as first-class event sources.

#### New Feed Types

| Feed Type | Sources | Event Type |
|---|---|---|
| Earthquakes | USGS (15min), EMSC (5min) | `natural_disaster.earthquake` |
| Volcanoes | Smithsonian USGS (1h) | `natural_disaster.volcano` |
| Hurricanes | NOAA ATCF, GDELT | `natural_disaster.hurricane` |
| Wildfires | MODIS (thermal), GDELT | `natural_disaster.wildfire` |
| Floods | GDELT, Dartmouth Flood Observatory | `natural_disaster.flood` |
| Conflicts | GDELT (15min), ACLED (daily) | `conflict` |
| Protests | GDELT, Event Registry | `protest` |
| Elections | GDELT, Wikipedia | `election` |
| Disease | WHO, ProMED, GDELT | `disease_outbreak` |
| Aviation | NOAA, marinetraffic.com | `aviation_incident` |
| Maritime | AIS, marinetraffic.com | `maritime_incident` |
| Weather | NOAA, ECMWF, WMO | `weather_extreme` |
| Economic | World Bank, IMF, tradingeconomics.com | `economic_release` |

#### Schema

```sql
ALTER TABLE news_sources ADD COLUMN source_kind TEXT DEFAULT 'news'
CHECK (source_kind IN ('news', 'government', 'scientific', 'emergency', 'social', 'economic'));

ALTER TABLE news_events ADD COLUMN external_source_ids JSONB;  -- ["usgs:12345", "gdeltevent:abc"]
ALTER TABLE news_events ADD COLUMN severity FLOAT;            -- 0.0-1.0
ALTER TABLE news_events ADD COLUMN alert_level TEXT;          -- green/yellow/orange/red
```

---

## Priority 5: NN Architecture

### 5.1 Embedding Dimension Benchmarking

Test embedding dimensions: 16, 32, 64, 128, 256.

#### Benchmark Script

```python
# worker/tests/test_embedding_benchmark.py

DIMENSIONS = [16, 32, 64, 128, 256]
METRICS = ['similarity_accuracy', 'storage_bytes', 'query_latency_ms',
           'clustering_nmi', 'downstream_f1']

def benchmark_embedding_dimension(dim: int) -> dict:
    """Train article_understanding at given dimension, measure all metrics."""
    model = ArticleUnderstandingModel(embedding_dim=dim)
    model.fit(train_features)

    # 1. Similarity accuracy: given known duplicate pairs, is cosine similarity high?
    dup_accuracy = evaluate_duplicate_detection(model, duplicate_pairs)

    # 2. Storage: total bytes in nn_article_embeddings
    storage = dim * 4 * article_count  # float32

    # 3. Query latency: cosine similarity search over 300K articles
    latency = measure_ann_latency(model, n_probe=10)

    # 4. Clustering NMI: do embeddings cluster by known event?
    nmi = measure_clustering_nmi(model, known_events)

    # 5. Downstream F1: event_matching F1 using these embeddings
    f1 = evaluate_event_matching_with_embeddings(model)

    return {
        'dimension': dim,
        'similarity_accuracy': dup_accuracy,
        'storage_bytes': storage,
        'query_latency_ms': latency,
        'clustering_nmi': nmi,
        'downstream_f1': f1,
    }

def test_embedding_dimension_tradeoffs():
    """Benchmark all dimensions and check for recommended target."""
    results = [benchmark_embedding_dimension(d) for d in DIMENSIONS]

    # Find optimal: highest downstream_f1 with latency < 50ms
    valid = [r for r in results if r['query_latency_ms'] < 50]
    best = max(valid, key=lambda r: r['downstream_f1'])

    print(f"Recommended dimension: {best['dimension']}")
    print(f"  downstream_f1: {best['downstream_f1']:.3f}")
    print(f"  query_latency_ms: {best['query_latency_ms']:.1f}")
    print(f"  storage_mb: {best['storage_bytes'] / 1e6:.1f}")

    # Storage growth should be roughly linear
    for i in range(1, len(results)):
        ratio = results[i]['storage_bytes'] / results[i-1]['storage_bytes']
        assert 1.5 < ratio < 3.5, f"unexpected storage growth at dim {results[i]['dimension']}"
```

**Expected result:** 128-dim is likely the sweet spot — 8× the storage of 16-dim but significantly better similarity accuracy and downstream F1.

### 5.2 Personalised News Ranking

#### Wire Session Updates

The key fix: connect `analytics.log` writes to `nn_realtime_session`.

```python
# In analytics handler: POST /api/analytics/log

def log_interaction(session_id: str, article_id: int, action: str, metadata: dict):
    article = get_article(article_id)
    session = get_or_create_session(session_id)

    # Get article's topic/country vectors
    topic_vec = get_article_topic_vector(article_id)  # from news_article_topics
    country_vec = get_article_country_vector(article_id)  # from news_locations
    category = article.event_type

    weight = INTERACTION_WEIGHTS.get(action, 1.0)

    db.unsafe("""
        INSERT INTO nn_realtime_session (
            session_id, last_interaction_at,
            topic_vector, country_vector, category_vector, source_vector,
            topic_weight_sum, country_weight_sum,
            interactions_6h, interactions_24h
        )
        VALUES (%s, now(),
            topic_vector     + (%s * %s),
            country_vector   + (%s * %s),
            category_vector  + (%s * %s),
            source_vector   + (%s * %s),
            topic_weight_sum + %s,
            country_weight_sum + %s,
            1, 1
        )
        ON CONFLICT (session_id) DO UPDATE SET
            topic_vector     = nn_realtime_session.topic_vector     + EXCLUDED.topic_vector,
            country_vector   = nn_realtime_session.country_vector   + EXCLUDED.country_vector,
            category_vector  = nn_realtime_session.category_vector  + EXCLUDED.category_vector,
            source_vector    = nn_realtime_session.source_vector    + EXCLUDED.source_vector,
            interactions_6h  = nn_realtime_session.interactions_6h  + 1,
            interactions_24h = nn_realtime_session.interactions_24h + 1,
            last_lat = COALESCE(%s, nn_realtime_session.last_lat),
            last_lng = COALESCE(%s, nn_realtime_session.last_lng),
            last_interaction_at = now()
    """, session_id,
        weight, topic_vec[0], weight, topic_vec[1],  # etc.
        metadata.get('lat'), metadata.get('lng'))

    # Also write to nn_prediction_log for metrics
    db.unsafe("""
        INSERT INTO nn_prediction_log (model_name, session_id, article_id, created_at)
        VALUES ('ranking', %s, %s, now())
    """, session_id, article_id)
```

#### Interest Decay

Add decay so old interests don't dominate:

```python
# Hourly decay job: run via cron
def decay_session_interests():
    """
    Decay all session vectors by 0.95× per hour.
    Reset interactions counters.
    """
    db.unsafe("""
        UPDATE nn_realtime_session SET
            topic_vector    = topic_vector    * 0.95,
            country_vector   = country_vector   * 0.95,
            category_vector  = category_vector  * 0.95,
            source_vector    = source_vector    * 0.95,
            interactions_6h  = 0,
            interactions_24h = GREATEST(interactions_24h - interactions_6h, 0)
        WHERE last_interaction_at < now() - INTERVAL '6 hours'
          AND last_interaction_at > now() - INTERVAL '7 days'
    """)
```

#### Tests

```python
# worker/tests/test_personalization.py

def test_session_vector_updated_on_interaction():
    """log_interaction updates the session's topic/country vectors"""
    session_id = create_test_session()
    article_id = create_test_article(topic_vector=[0.1]*64, country_vector=[0.2]*64)
    log_interaction(session_id, article_id, 'click', {})
    session = get_session(session_id)
    # Vector should have increased, not be all zeros
    assert sum(session.topic_vector) > 0

def test_interaction_weights():
    """Higher-weight interactions produce larger vector changes"""
    s = create_test_session()
    a = create_test_article(topic_vector=[0.1]*64)
    before = get_session(s).topic_vector.copy()
    log_interaction(s, a, 'click', {})  # weight = 1.0
    after_click = get_session(s).topic_vector.copy()
    log_interaction(s, a, 'share', {})  # weight = 3.0
    after_share = get_session(s).topic_vector.copy()
    change_click = sum(after_click - before)
    change_share = sum(after_share - after_click)
    assert change_share > change_click

def test_session_vector_normalized():
    """Session vectors remain unit-length after many updates"""
    session_id = create_test_session()
    for _ in range(100):
        article_id = create_test_article()
        log_interaction(session_id, article_id, 'click', {})
    session = get_session(session_id)
    topic_norm = sum(x*x for x in session.topic_vector) ** 0.5
    assert 0.99 < topic_norm <= 1.01

def test_decay_reduces_old_interests():
    """Sessions without recent interaction decay"""
    session_id = create_test_session()
    article_id = create_test_article(topic_vector=[0.5]*64)
    log_interaction(session_id, article_id, 'click', {})
    vectors_before = get_session(session_id).topic_vector.copy()
    # Simulate 6 hours passing
    db.unsafe("UPDATE nn_realtime_session SET last_interaction_at = now() - INTERVAL '7 hours'")
    decay_session_interests()
    vectors_after = get_session(session_id).topic_vector.copy()
    assert sum(vectors_after) < sum(vectors_before)

def test_new_article_appears_for_interested_session():
    """An article matching session interests ranks above non-matching articles"""
    # Create session interested in "technology"
    session_id = create_test_session()
    for a_id in find_articles_with_topic('technology'):
        log_interaction(session_id, a_id, 'click', {})
    # Get leaderboard for this session
    leaderboard = get_leaderboard(session_id=session_id, limit=10)
    # Check that technology articles rank higher than average
    tech_articles = [a for a in leaderboard['items'] if 'technology' in a.get('topics', [])]
    avg_rank = sum(tech_articles[i]['rank'] for i in range(len(tech_articles))) / max(len(tech_articles), 1)
    assert avg_rank < 5  # should appear in top 5
```

---

## Priority 6: Security & Operational Reliability

### Implemented

- ✅ Rate limiting (`ratelimit.ts`)
- ✅ Request validation (Zod schemas)
- ✅ Admin key authentication
- ✅ Circuit breaker (`ai-breaker.ts`)
- ✅ Queue with job status tracking
- ✅ HTML sanitization (DOMPurify)
- ✅ Honeypot spam protection

### Missing

| Item | Priority | Status |
|---|---|---|
| Secrets management (API keys, DB credentials) | Critical | Missing — use env vars only |
| Database backups (automated) | Critical | Missing |
| Backup verification (test restores) | Critical | Missing |
| Feed poisoning detection (fake news source) | High | Missing |
| Malicious article detection | High | Missing |
| Prompt injection defenses | High | Missing |
| Source authentication (signed feeds) | Medium | Missing |
| Audit logs for admin actions | Medium | Missing |
| Model artifact signing | Medium | Missing |
| Model rollback (automated) | Medium | Missing |
| API abuse detection | High | Missing |
| Monitoring dashboard | High | Missing |
| Alerting (PagerDuty/Slack) | Medium | Missing |

---

## Implementation Phases

### Phase 1: Data Quality Foundation (1-2 weeks)
1. Add `news_article_locationCandidates` table
2. Add `location_metadata` JSONB column
3. Update `worker/extract.py` to populate candidates
4. Update `worker/geocode.py` to store candidates + verification
5. Add `nn_country_intelligence` table + refresh view
6. Add source quality columns to `news_sources`
7. Tests for all of the above

### Phase 2: Labeling Infrastructure (1-2 weeks)
1. Add `/api/admin/nn/*` endpoints
2. Build admin NN dashboard UI
3. Event matching labeling interface
4. Geolocation labeling interface
5. Entity extraction labeling interface
6. Relationship labeling interface
7. Label count → auto-train eligibility check
8. Tests for labeling pipeline

### Phase 3: Coverage Model Fix (3-5 days)
1. Add `country_borders` table
2. Fix `extract_coverage()` SQL query
3. Fix `infer_coverage()` to use real features
4. Tests

### Phase 4: ML Scoreboard + Auto-Loop (1-2 weeks)
1. Add `nn_prediction_log` table
2. Add `nn_v_scoreboard` view
3. Add scoreboard API endpoint
4. Implement shadow deploy for A/B testing
5. Implement auto-train trigger
6. Implement model promotion workflow
7. Tests

### Phase 5: Event Timelines + Intelligence Cards (1 week)
1. Add `news_event_timeline` table
2. Build timeline construction in cluster.py or separate module
3. Add `/api/events/:id/intelligence-card` endpoint
4. Tests

### Phase 6: Source Expansion + Non-News Feeds (2-4 weeks)
1. Add `source_kind` and `external_source_ids` to schema
2. Add GDELT, USGS, NOAA feed handlers
3. Implement `discover_sources_for_country()`
4. Add severity + alert_level to events
5. Tests

### Phase 7: Semantic Search (1-2 weeks)
1. Build query parser
2. Add semantic search API endpoint
3. Integrate with existing search
4. Tests

### Phase 8: Personalization (1 week)
1. Wire `analytics.log` → `nn_realtime_session` updates
2. Add interest decay cron job
3. Add session vector normalization
4. Tests

### Phase 9: NN Architecture (1-2 weeks)
1. Write embedding dimension benchmark
2. Test 16/32/64/128/256 dims
3. Implement upgrade path
4. Update schema from vector(16) to vector(128)

---

## Test Plan

All tests go in `worker/tests/`.

| Test File | What it tests | Lines |
|---|---|---|
| `test_location_quality.py` | Precision enum, confidence range, candidates table, low_confidence_flag, disputed flag | ~100 |
| `test_source_quality.py` | Profile JSONB structure, quality score range, citation graph symmetry, story overlap | ~80 |
| `test_country_intelligence.py` | All countries present, volume non-negative, coverage scores, language coverage | ~80 |
| `test_labeling.py` | Label validation, enum checks, nn_user_corrections writes, auto-train trigger | ~100 |
| `test_coverage_features.py` | All countries covered, gap_score >= 0, neighbor gaps <= 8, feature stability | ~60 |
| `test_learning_loop.py` | Auto-train eligibility, uncertain labels don't count, A/B shadow deploy, promote | ~60 |
| `test_event_timeline.py` | Chronological order, first_report flag, local/intl distinction, sequence continuity | ~60 |
| `test_personalization.py` | Vector updates on interaction, interaction weights, normalization, decay, ranking | ~80 |
| `test_embedding_benchmark.py` | All dimensions benchmarked, storage growth linear, latency < 50ms, recommendation | ~50 |
| `test_semantic_search.py` | Query parsing, entity extraction, time parsing, geo resolution, fallback to keyword | ~80 |
| `test_source_discovery.py` | Feed validation, country+topic targeting, pending validation state | ~60 |
| `test_nonasync_event_feeds.py` | USGS parsing, GDELT parsing, severity calculation, external_source_ids | ~80 |

**Total new tests: ~810 lines**

Run all with:
```bash
pytest worker/tests/test_location_quality.py \
       worker/tests/test_source_quality.py \
       worker/tests/test_country_intelligence.py \
       worker/tests/test_labeling.py \
       worker/tests/test_coverage_features.py \
       worker/tests/test_learning_loop.py \
       worker/tests/test_event_timeline.py \
       worker/tests/test_personalization.py \
       worker/tests/test_embedding_benchmark.py \
       worker/tests/test_semantic_search.py \
       worker/tests/test_source_discovery.py \
       worker/tests/test_nonasync_event_feeds.py \
       -v --tb=short
```
