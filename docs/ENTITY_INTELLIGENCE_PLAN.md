# XYZO Entity Intelligence System — Planning Document

## The Vision

Every person, company, and organization on Earth has a story. XYZO should know:
- **WHO** they are (people, companies, organizations)
- **WHERE** they are (headquarters, offices, branches)
- **WHAT** they do (industry, products, services)
- **HOW** they connect (partnerships, subsidiaries, competitors)
- **WHEN** they appear in news (trending, breaking, ongoing)

This is the **Entity Intelligence Layer** — as important as the cities database.

---

## Part 1: Company/Organization Database

### What We Need

A structured database of companies and organizations worldwide:

```
COMPANY
├── name (official)
├── aliases (brand names, abbreviations)
├── headquarters (city, country, lat/lng)
├── industry/sector
├── employee_count (approximate)
├── founded_year
├── website
├── stock_ticker (if public)
├── parent_company (for subsidiaries)
├── subsidiaries (list)
├── subsidiaries (list)
├── competitors (list)
├── news_sources (RSS feeds that cover them)
├── social_media (Twitter, LinkedIn, etc.)
└── reliability_score (how often they appear in news)
```

### Data Sources

| Source | What It Provides | API Key? |
|--------|------------------|----------|
| Wikidata | Company info, HQ, industry | ❌ No |
| OpenCorporates | Corporate data, subsidiaries | ❌ No (limited) |
| Crunchbase | Startups, funding | ⚠️ Limited free |
| SEC EDGAR | US public companies | ❌ No |
| Companies House (UK) | UK companies | ❌ No |
| Google Knowledge Graph | Company info | ⚠️ Limited |
| Wikipedia | Company profiles | ❌ No |

### Implementation Plan

**Phase 1: Core Company Database**
- Import from Wikidata (SPARQL queries)
- Store: name, HQ, industry, employees, website
- Link to news articles via entity matching

**Phase 2: News Source Mapping**
- Map each company to its RSS feeds
- Track which sources cover which companies
- Build company→source reliability scores

**Phase 3: Relationship Graph**
- Parent-subsidiary relationships
- Competitor mapping
- Partnership detection from news

### NN/AI Applications

1. **Entity Recognition** — Extract company names from articles
2. **Industry Classification** — Categorize companies by sector
3. **Sentiment Analysis** — Track company reputation in news
4. **Trend Detection** — Identify when companies are trending
5. **Relationship Inference** — Detect partnerships from co-occurrence

---

## Part 2: People Database

### What We Need

A structured database of notable people:

```
PERSON
├── name (full)
├── aliases (nicknames, maiden names)
├── birth_date
├── birth_place (city, country)
├── nationality
├── occupation
├── organization (employer/affiliation)
├── notable_for (achievements)
├── social_media (Twitter, LinkedIn, etc.)
├── news_frequency (how often they appear)
└── topic_associations (what topics they're linked to)
```

### Data Sources

| Source | What It Provides | API Key? |
|--------|------------------|----------|
| Wikidata | Person info, birth, occupation | ❌ No |
| Wikipedia | Biographical data | ❌ No |
| OpenSanctions | PEPs, sanctions | ❌ No |
| LinkedIn (public) | Professional info | ⚠️ Limited |
| Google Knowledge Graph | Person info | ⚠️ Limited |

### Implementation Plan

**Phase 1: Core Person Database**
- Import notable people from Wikidata
- Store: name, birth, occupation, nationality
- Link to news articles via entity matching

**Phase 2: News Person Mapping**
- Track which people appear in which stories
- Build person→topic associations
- Detect emerging public figures

**Phase 3: Relationship Graph**
- Family relationships (from Wikidata)
- Professional relationships (colleagues, competitors)
- Event co-occurrence (people at same events)

### NN/AI Applications

1. **Person Recognition** — Extract person names from articles
2. **Role Classification** — CEO, politician, athlete, etc.
3. **Sentiment Tracking** — Public perception of individuals
4. **Influence Mapping** — Who influences whom
5. **Timeline Construction** — Career/event timelines

---

## Part 3: Algorithm Design

### Entity Extraction Pipeline

```
ARTICLE TEXT
    ↓
NLP EXTRACTION (spaCy / transformers)
    ↓
ENTITY RECOGNITION (NER)
    ├── Person names
    ├── Organization names
    ├── Location names
    └── Event names
    ↓
ENTITY LINKING (Wikidata / Wikipedia)
    ├── Match to known entities
    ├── Disambiguate duplicates
    └── Link to structured data
    ↓
RELATIONSHIP DETECTION
    ├── Co-occurrence in same article
    ├── Explicit relationships (CEO of, founded by)
    └── Temporal relationships (before, after)
    ↓
GRAPH CONSTRUCTION
    ├── Entity nodes
    ├── Relationship edges
    └── Topic associations
```

### NN/AI Models Needed

| Model | Purpose | Architecture |
|-------|---------|--------------|
| `entity_extraction` | Extract entities from text | BiLSTM-CRF or Transformer NER |
| `entity_linking` | Match to Wikidata | Entity embedding + similarity |
| `relationship_detection` | Find entity relationships | Relation extraction model |
| `sentiment_tracking` | Track entity sentiment | Sentiment analysis |
| `topic_association` | Link entities to topics | Topic modeling + clustering |

### Data Pipeline

```
NEWS ARTICLES
    ↓
ENTITY EXTRACTION (NER)
    ↓
ENTITY LINKING (Wikidata)
    ↓
RELATIONSHIP DETECTION
    ↓
GRAPH CONSTRUCTION
    ↓
NN TRAINING (from graph structure)
    ↓
PREDICTION (new articles)
    ↓
GRAPH UPDATE
```

---

## Part 4: Database Schema

### companies table

```sql
CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT[],
  headquarters_city TEXT,
  headquarters_country TEXT,
  headquarters_lat DOUBLE PRECISION,
  headquarters_lng DOUBLE PRECISION,
  industry TEXT,
  sector TEXT,
  employee_count INTEGER,
  founded_year INTEGER,
  website TEXT,
  stock_ticker TEXT,
  parent_company_id INTEGER REFERENCES companies(id),
  wikidata_id TEXT,
  wikipedia_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_companies_name ON companies USING GIN (to_tsvector('english', name));
CREATE INDEX idx_companies_industry ON companies (industry);
CREATE INDEX idx_companies_country ON companies (headquarters_country);
```

### people table

```sql
CREATE TABLE people (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT[],
  birth_date DATE,
  birth_city TEXT,
  birth_country TEXT,
  nationality TEXT,
  occupation TEXT,
  organization_id INTEGER REFERENCES companies(id),
  notable_for TEXT,
  wikidata_id TEXT,
  wikipedia_url TEXT,
  news_frequency INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_people_name ON people USING GIN (to_tsvector('english', name));
CREATE INDEX idx_people_occupation ON people (occupation);
CREATE INDEX idx_people_nationality ON people (nationality);
```

### entity_mentions table

```sql
CREATE TABLE entity_mentions (
  id SERIAL PRIMARY KEY,
  article_id INTEGER REFERENCES news_articles(id),
  entity_type TEXT NOT NULL, -- 'person' or 'company'
  entity_id INTEGER NOT NULL,
  mention_count INTEGER DEFAULT 1,
  sentiment DOUBLE PRECISION, -- -1 to 1
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_entity_mentions_article ON entity_mentions (article_id);
CREATE INDEX idx_entity_mentions_entity ON entity_mentions (entity_type, entity_id);
CREATE INDEX idx_entity_mentions_time ON entity_mentions (created_at DESC);
```

### entity_relationships table

```sql
CREATE TABLE entity_relationships (
  id SERIAL PRIMARY KEY,
  entity_a_type TEXT NOT NULL,
  entity_a_id INTEGER NOT NULL,
  entity_b_type TEXT NOT NULL,
  entity_b_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL, -- 'parent', 'subsidiary', 'competitor', 'colleague', etc.
  strength DOUBLE PRECISION DEFAULT 1.0,
  source_article_id INTEGER REFERENCES news_articles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_a_type, entity_a_id, entity_b_type, entity_b_id, relationship_type)
);

CREATE INDEX idx_entity_rel_a ON entity_relationships (entity_a_type, entity_a_id);
CREATE INDEX idx_entity_rel_b ON entity_relationships (entity_b_type, entity_b_id);
```

---

## Part 5: API Endpoints

### Company Endpoints

```
GET /api/companies?search=...&industry=...&country=...
GET /api/companies/:id
GET /api/companies/:id/news
GET /api/companies/:id/relationships
GET /api/companies/:id/sentiment
```

### Person Endpoints

```
GET /api/people?search=...&occupation=...&nationality=...
GET /api/people/:id
GET /api/people/:id/news
GET /api/people/:id/relationships
GET /api/people/:id/timeline
```

### Entity Endpoints

```
GET /api/entities/search?q=...&type=person|company
GET /api/entities/:type/:id
GET /api/entities/:type/:id/news
GET /api/entities/:type/:id/relationships
```

---

## Part 6: Frontend Integration

### Entity Cards

When clicking on a story, show:
- **People mentioned** → Click to see their profile
- **Companies mentioned** → Click to see their profile
- **Related stories** → Stories about the same entities

### Entity Profiles

New page/panel showing:
- **Basic info** (name, occupation, HQ)
- **News timeline** (recent stories)
- **Relationships** (who they're connected to)
- **Sentiment trend** (how they're perceived)
- **Topic associations** (what they're known for)

### Map Integration

- **Company markers** — Show company HQs on map
- **People markers** — Show notable people's locations
- **Entity clusters** — Group entities by location
- **Relationship lines** — Show connections between entities

---

## Part 7: NN/AI Training Data

### What We Need

1. **Labeled entities** — Articles with entities marked
2. **Entity relationships** — Pairs of related entities
3. **Sentiment labels** — Positive/negative/neutral mentions
4. **Topic associations** — Entity→topic mappings

### Training Pipeline

```
1. Import from Wikidata (structured data)
2. Extract entities from existing articles (NER)
3. Link entities to Wikidata (entity linking)
4. Detect relationships (co-occurrence + explicit)
5. Label sentiment (rule-based + NN)
6. Train models on labeled data
7. Use models to process new articles
8. Update graph with new entities/relationships
```

### Model Training Schedule

| Model | Training Data | Frequency |
|-------|---------------|-----------|
| entity_extraction | NER-labeled articles | Weekly |
| entity_linking | Wikidata matches | Monthly |
| relationship_detection | Co-occurrence pairs | Weekly |
| sentiment_tracking | Sentiment-labeled mentions | Monthly |
| topic_association | Topic-entity pairs | Weekly |

---

## Part 8: Implementation Roadmap

### Phase 1: Foundation (1-2 weeks)
- [ ] Design database schema
- [ ] Create migration files
- [ ] Import Wikidata companies (top 1000)
- [ ] Import Wikidata people (top 1000)
- [ ] Basic API endpoints

### Phase 2: Entity Extraction (2-3 weeks)
- [ ] NER pipeline for company names
- [ ] NER pipeline for person names
- [ ] Entity linking to Wikidata
- [ ] Entity mention tracking

### Phase 3: Relationship Graph (2-3 weeks)
- [ ] Co-occurrence detection
- [ ] Explicit relationship extraction
- [ ] Relationship graph storage
- [ ] Graph query API

### Phase 4: NN Training (3-4 weeks)
- [ ] Training data generation
- [ ] Model training pipeline
- [ ] Model evaluation
- [ ] Production deployment

### Phase 5: Frontend Integration (2-3 weeks)
- [ ] Entity cards in popups
- [ ] Entity profile pages
- [ ] Map entity markers
- [ ] Relationship visualization

---

## Part 9: Metrics & Success Criteria

### What Success Looks Like

| Metric | Current | Target |
|--------|---------|--------|
| Companies indexed | 0 | 10,000+ |
| People indexed | 0 | 5,000+ |
| Entity mentions tracked | 0 | 100,000+ |
| Entity relationships mapped | 0 | 50,000+ |
| NER accuracy | N/A | >85% |
| Entity linking accuracy | N/A | >80% |
| Relationship detection F1 | N/A | >70% |

### How We'll Measure

1. **Precision** — % of extracted entities that are correct
2. **Recall** — % of real entities that are extracted
3. **F1 Score** — Harmonic mean of precision and recall
4. **Relationship Accuracy** — % of detected relationships that are real
5. **User Engagement** — Clicks on entity cards, time on entity profiles

---

## Part 10: The Big Picture

### Why This Matters

XYZO currently knows:
- **WHERE** things happen (cities, coordinates)
- **WHAT** happens (categories, topics)
- **WHEN** it happens (timestamps)

Adding Entity Intelligence means XYZO will also know:
- **WHO** is involved (people, companies)
- **HOW** they're connected (relationships)
- **WHY** it matters (sentiment, influence)

This transforms XYZO from a **news map** into a **knowledge graph** — a living, breathing model of the world's information ecosystem.

### The Flywheel

```
More Articles
    ↓
More Entity Extraction
    ↓
More Relationships Discovered
    ↓
Better NN Models
    ↓
Better Entity Recognition
    ↓
More Accurate Knowledge Graph
    ↓
Better Search & Discovery
    ↓
More User Engagement
    ↓
More Articles (from user submissions)
```

### The End Goal

A system that can answer questions like:
- "What companies are affected by this supply chain disruption?"
- "Who are the key people involved in this negotiation?"
- "What organizations are competing in this market?"
- "How does this event connect to previous events?"

**This is the next evolution of XYZO — from mapping news to mapping knowledge.**

---

## Next Steps

1. **Review this plan** with the team
2. **Prioritize** which features matter most
3. **Start with Phase 1** — get the foundation right
4. **Iterate** based on what we learn

The Entity Intelligence Layer will make XYZO not just a map of news, but a map of **understanding**. 🌍🧠✨
