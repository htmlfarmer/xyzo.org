# XYZO NLP Feature Stack - Implementation Plan

## Vision
Build a rich, multi-faceted NLP system that extracts **independent, measurable signals** from articles, feeding into the NN/world model. Not dumping raw text into a giant model, but rather **many small, independent measurements that reinforce one another**.

```
RAW TEXT
    +
NLP INFORMATION VECTOR (20 feature families)
    +
EMBEDDING
    +
CORPUS FEATURES
    ↓
SHARED ENCODER (Multi-task NN)
    ↓
STORY / EVENT / WORLD MODEL
```

---

## Current State

### What We Have
| Feature | Table/Field | Status |
|---------|-------------|--------|
| Entities | `news_articles.entities` (text[]) | 34k populated, simple array |
| Word Frequency | `news_articles.word_freq` (jsonb) | 808k populated |
| Topic Tags | `news_articles.topic_tags` (text[]) | Basic |
| Article Facts | `article_facts` table | 644k rows, minimal schema |
| Event Clustering | `news_events` + `news_event_sources` | Working |

### What's Missing (Your Priority List)
| Priority | Feature | Current State |
|---------|---------|--------------|
| 🔴 1 | Entity density + structure | Simple array only |
| 🔴 2 | Places + geographic roles | Lat/lng only |
| 🔴 3 | Dates/time/event timing | Basic timestamp |
| 🔴 4 | Quantities | Not extracted |
| 🔴 5 | Claims | Not extracted |
| 🔴 6 | Event extraction | Basic event_type |
| 🔴 7 | Attribution | Not extracted |
| 🔴 8 | Certainty/modality | Not extracted |
| 🔴 9 | Frequency/TF-IDF | Partial (new table) |
| 🔴 10 | N-grams/PMI | Partial (new table) |
| 🟠 11 | Novelty | Not computed |
| 🟠 12 | Contradiction/support | Not extracted |
| 🟠 13 | Co-occurrence | Partial |
| 🟠 14 | Burst detection | Partial |
| 🟠 15 | Sentiment/emotion | Not extracted |
| 🟠 16 | Topic probabilities | Basic topic_tags |
| 🟡 17 | Linguistic fingerprint | Partial (word_freq) |
| 🟡 18 | Framing | Not extracted |
| 🟡 19 | Source fingerprint | Not extracted |
| 🟡 20 | Sentence density | Not extracted |

---

## Phase 1: Foundation (Safe - Won't Break Live Site)

### 1.1 Expand `article_facts` Table

Add new columns for each feature family. **No schema changes to existing tables**.

```sql
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS entity_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS temporal_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS quantity_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS claim_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS attribution_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS certainty_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS event_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS novelty_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS geographic_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS linguistic_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS sentiment_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS framing_features JSONB;
ALTER TABLE article_facts ADD COLUMN IF NOT EXISTS corpus_features JSONB;
```

### 1.2 Entity Features (Priority 1)

```json
{
  "entity_count": 5,
  "unique_entity_count": 4,
  "person_count": 2,
  "organization_count": 1,
  "location_count": 1,
  "product_count": 0,
  "event_count": 0,
  "entity_density": 0.15,
  "entity_repeat_rate": 0.2,
  "entities": [
    {
      "name": "Tesla",
      "type": "organization",
      "role": "subject",
      "frequency": 3,
      "first_position": 12,
      "sentiment": "positive"
    }
  ],
  "relationships": [
    {
      "subject": "Tesla",
      "predicate": "announced",
      "object": "factory",
      "location": "Texas"
    }
  ]
}
```

### 1.3 Temporal Features (Priority 3)

```json
{
  "has_absolute_date": true,
  "has_relative_date": false,
  "absolute_dates": ["2024-03-15"],
  "relative_dates": [],
  "temporal_classification": "PAST",
  "event_time": "2024-03-15T00:00:00Z",
  "publication_time": "2024-03-16T10:30:00Z",
  "discovery_time": "2024-03-16T11:00:00Z",
  "time_since_event_hours": 24,
  "duration_mentioned": "3 days",
  "recurrence": null
}
```

### 1.4 Quantity Features (Priority 4)

```json
{
  "quantities": [
    {
      "raw": "$2 billion",
      "value": 2000000000,
      "unit": "USD",
      "type": "money"
    },
    {
      "raw": "47 people",
      "value": 47,
      "unit": "people",
      "type": "count"
    },
    {
      "raw": "18%",
      "value": 18,
      "unit": "%",
      "type": "percentage"
    }
  ],
  "money_total": 2000000000,
  "people_total": 47,
  "percentage_total": 18,
  "quantity_count": 3
}
```

### 1.5 Claim Features (Priority 5)

```json
{
  "claims": [
    {
      "id": "c1",
      "subject": "Tesla",
      "predicate": "will build",
      "object": "factory",
      "location": "Texas",
      "time": "future",
      "certainty": "planned",
      "attribution": "company"
    }
  ],
  "claim_count": 1,
  "factual_claims": 0,
  "opinion_claims": 1
}
```

### 1.6 Attribution Features (Priority 7)

```json
{
  "direct_claim_count": 2,
  "attributed_claim_count": 5,
  "anonymous_source_count": 0,
  "official_source_count": 3,
  "expert_source_count": 1,
  "witness_source_count": 2,
  "attribution_markers": [
    {"phrase": "according to officials", "count": 2},
    {"phrase": "the company said", "count": 3}
  ]
}
```

### 1.7 Certainty Features (Priority 8)

```json
{
  "certainty_distribution": {
    "confirmed": 0.1,
    "reported": 0.4,
    "probable": 0.2,
    "possible": 0.1,
    "speculative": 0.1,
    "denied": 0.0,
    "predicted": 0.1
  },
  "modal_verbs": ["will", "may", "could"],
  "hedging_count": 3,
  "certainty_score": 0.65
}
```

### 1.8 Event Features (Priority 6)

```json
{
  "event_type": "natural_disaster",
  "event_stage": "ongoing",
  "event_time": "2024-03-15T06:00:00Z",
  "event_location": {"lat": 9.0, "lng": 8.5, "name": "Nigeria"},
  "participants": ["government", "residents"],
  "affected_population": 12000,
  "severity": "high",
  "magnitude": null,
  "duration_hours": 48
}
```

### 1.9 Novelty Features (Priority 11)

```json
{
  "new_entity_rate": 0.6,
  "new_claim_rate": 0.8,
  "new_fact_rate": 0.5,
  "new_quantity_rate": 0.3,
  "new_location_rate": 0.2,
  "semantic_novelty": 0.72,
  "information_density": 0.85,
  "update_to_existing_story": true,
  "contradicts_previous": false
}
```

### 1.10 Geographic Features (Priority 2 & 10)

```json
{
  "mentioned_locations": [
    {"name": "Japan", "role": "origin"},
    {"name": "Texas", "role": "event_location"},
    {"name": "Washington", "role": "meeting_location"}
  ],
  "event_location_confidence": 0.9,
  "primary_location": "Texas",
  "secondary_locations": ["Japan", "Washington"],
  "location_roles": {
    "event": "Texas",
    "origin": "Japan",
    "meeting": "Washington"
  }
}
```

### 1.11 Linguistic Features (Priority 17)

```json
{
  "word_count": 523,
  "unique_word_count": 312,
  "type_token_ratio": 0.596,
  "lexical_entropy": 5.8,
  "sentence_count": 12,
  "avg_sentence_length": 43.6,
  "avg_word_length": 5.2,
  "noun_ratio": 0.32,
  "verb_ratio": 0.18,
  "adjective_ratio": 0.12,
  "technical_term_ratio": 0.08,
  "numeric_density": 0.05,
  "ngrams": {
    "bigrams": ["climate change", "carbon emissions"],
    "trigrams": ["new electric vehicle"]
  }
}
```

### 1.12 Sentiment Features (Priority 15)

```json
{
  "overall_sentiment": 0.23,
  "sentiment_label": "slightly_positive",
  "emotions": {
    "fear": 0.12,
    "hope": 0.31,
    "anger": 0.05,
    "sadness": 0.08
  },
  "emotion_intensity": 0.45,
  "targeted_sentiments": [
    {"target": "government", "sentiment": -0.2},
    {"target": "residents", "sentiment": 0.4}
  ]
}
```

### 1.13 Framing Features (Priority 18)

```json
{
  "primary_frame": "economic",
  "secondary_frames": ["human", "environmental"],
  "frame_scores": {
    "economic": 0.8,
    "human": 0.6,
    "environmental": 0.5,
    "scientific": 0.2,
    "political": 0.3,
    "legal": 0.1
  }
}
```

### 1.14 Corpus Features (Priority 9, 12)

```json
{
  "entity_rarity": 0.72,
  "term_rarity": 0.45,
  "topic_rarity": 0.3,
  "geographic_rarity": 0.6,
  "event_rarity": 0.4,
  "tfidf_scores": {
    "reparation": 1.18,
    "slavery": 1.13
  },
  "burst_score": 2.4,
  "z_score": 1.8
}
```

---

## Phase 2: Extraction Workers

### 2.1 Worker Architecture

```python
# worker/nlp_extractor.py
# Runs after article is fetched, extracts all feature families
# Stores results in article_facts
# Does NOT affect live site - just populates new table

class NLPFeatureExtractor:
    def extract_entity_features(self, article) -> dict
    def extract_temporal_features(self, article) -> dict
    def extract_quantity_features(self, article) -> dict
    def extract_claim_features(self, article) -> dict
    def extract_attribution_features(self, article) -> dict
    def extract_certainty_features(self, article) -> dict
    def extract_event_features(self, article) -> dict
    def extract_novelty_features(self, article) -> dict
    def extract_geographic_features(self, article) -> dict
    def extract_linguistic_features(self, article) -> dict
    def extract_sentiment_features(self, article) -> dict
    def extract_framing_features(self, article) -> dict
    def extract_corpus_features(self, article) -> dict
```

### 2.2 Extraction Priority Order

| Phase | Features | Extraction Method |
|-------|----------|-------------------|
| 1 | Linguistic (basic) | Regex + spaCy |
| 1 | Quantity | Regex + number parsing |
| 2 | Entity + Geographic | spaCy NER |
| 2 | Temporal | HeidelDATE / spaCy |
| 3 | Attribution | Regex patterns |
| 3 | Certainty | Lexicon + spaCy |
| 4 | Claims | OpenIE / spaCy |
| 4 | Event | Rule-based + spaCy |
| 5 | Sentiment | VADER / transformer |
| 5 | Framing | Multi-label classifier |
| 6 | Novelty | Comparison to corpus |
| 7 | Burst | Time-series analysis |

---

## Phase 3: NN Integration

### 3.1 Modify `nn_features.py`

Replace current features with enriched feature set:

```python
# Before (current)
features = {
    "title": str,
    "body": str[:512],
    "word_count": int,
    ...
}

# After (proposed)
features = {
    # From article_facts
    "entity_features": {...},
    "temporal_features": {...},
    "quantity_features": {...},
    "claim_features": {...},
    "linguistic_features": {...},
    "corpus_features": {...},

    # Metadata
    "source_country": str,
    "language": str,
    "published_hour": int,
    "published_weekday": int,

    # Derived
    "entity_count": int,
    "quantity_count": int,
    "claim_count": int,
}
```

### 3.2 Multi-Task Architecture

```
                    ARTICLE
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           LEXICAL   ENTITY  TEMPORAL
              │        │        │
              ▼        ▼        ▼
           SYNTAX   GEO     QUANTITY
              │        │        │
              └────────┼────────┘
                       ▼
              FEATURE FUSION LAYER
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           TOPIC    EVENT    SENTIMENT
              │        │        │
              └────────┼────────┘
                       ▼
                 WORLD MODEL
```

---

## Phase 4: Safe Deployment

### 4.1 No Breaking Changes
- All new features go into `article_facts` (new table)
- `news_articles` table unchanged
- Existing API endpoints unchanged
- Existing NN models continue to work

### 4.2 Feature Flags
```javascript
// Only use new features when available
const useRichFeatures = article_facts?.entity_features != null;
const features = useRichFeatures ? article_facts : legacyFeatures;
```

### 4.3 Gradual Rollout
1. Populate `article_facts` for new articles only
2. Backfill for recent articles (last 30 days)
3. Enable rich features in NN for new models
4. Retrain existing models with new features
5. Full rollout

---

## Implementation Roadmap

### Week 1: Foundation
- [ ] Expand `article_facts` table with all feature columns
- [ ] Create `worker/nlp_extractor.py` skeleton
- [ ] Implement quantity extraction (regex-based)
- [ ] Implement basic linguistic features

### Week 2: Core NLP
- [ ] Implement entity extraction with roles
- [ ] Implement temporal features
- [ ] Implement geographic role extraction
- [ ] Connect to article processing pipeline

### Week 3: Knowledge
- [ ] Implement attribution features
- [ ] Implement certainty/modality
- [ ] Implement claim extraction (basic)
- [ ] Begin event features

### Week 4: Advanced
- [ ] Implement sentiment analysis
- [ ] Implement framing classification
- [ ] Implement novelty calculation
- [ ] Integrate with NN training

### Week 5+: Polish
- [ ] Optimize extraction speed
- [ ] Add burst detection
- [ ] Implement contradiction detection
- [ ] Full multi-task NN training

---

## Key Principles

1. **Don't break live site** - All changes additive only
2. **Independent features** - Each feature family stands alone
3. **Incremental** - Build one feature at a time
4. **Measurable** - Every feature has a clear definition
5. **Multi-task** - One representation supports many tasks
6. **Corpus-aware** - Features compare to what XYZO knows

---

## Success Metrics

| Feature Family | Metric | Target |
|---------------|--------|--------|
| Entities | Coverage | >90% articles |
| Quantities | Extraction rate | >80% |
| Claims | Claims per article | 2-5 avg |
| Temporal | Classification accuracy | >85% |
| Novelty | Correlation with user engagement | >0.3 |
| Sentiment | Agreement with human标注 | >70% |

---

## Example: Before vs After

### Before (Current State)
```python
# Only 512 chars of body + basic metadata
features = {
    "title": "Tesla announces new factory in Texas",
    "body": "Tesla will build a new factory...",
    "word_count": 45,
    "entities": ["Tesla", "Texas"]
}
```

### After (Proposed)
```python
features = {
    # Entity Features
    "entity_features": {
        "entity_count": 3,
        "organization_count": 1,
        "location_count": 1,
        "entities": [
            {"name": "Tesla", "type": "organization", "role": "subject"},
            {"name": "Texas", "type": "location", "role": "event_location"}
        ],
        "relationships": [
            {"subject": "Tesla", "predicate": "build", "object": "factory", "location": "Texas"}
        ]
    },

    # Quantity Features
    "quantity_features": {
        "quantities": [
            {"raw": "$2 billion", "value": 2000000000, "unit": "USD", "type": "money"}
        ],
        "money_total": 2000000000
    },

    # Temporal Features
    "temporal_features": {
        "temporal_classification": "FUTURE",
        "event_time": "2025-01-01",
        "publication_time": "2024-03-16"
    },

    # Claim Features
    "claim_features": {
        "claims": [
            {"subject": "Tesla", "predicate": "will build", "object": "factory", "certainty": "planned"}
        ]
    },

    # Geographic Features
    "geographic_features": {
        "location_roles": {"event": "Texas"},
        "primary_location": "Texas"
    },

    # Linguistic Features
    "linguistic_features": {
        "word_count": 45,
        "type_token_ratio": 0.78,
        "lexical_entropy": 4.2
    },

    # Corpus Features
    "corpus_features": {
        "tfidf_scores": {"factory": 1.2, "tesla": 0.8},
        "entity_rarity": 0.6
    },

    # Basic metadata
    "source_country": "US",
    "language": "en",
    "published_hour": 10,
    "published_weekday": 6
}
```

This is the **rich, structured input** that transforms XYZO from a document store into a **computable model of the world's information**.
