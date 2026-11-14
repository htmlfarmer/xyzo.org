# XYZO SYSTEM MAP

## Complete Architecture Overview

### Major Applications

| Application | Type | Location | LOC | Purpose |
|-------------|------|----------|-----|---------|
| API Server | Bun + Hono | `api/src/` | 16,559 | REST API, WebSocket, auth |
| Worker Pipeline | Python 3.11 | `worker/` | 47,250 | Ingestion, extraction, geocoding |
| Frontend | Vanilla JS | `public_html/` | 18,392 | Leaflet map, SPA |
| NN Inference | Python + PyTorch | `worker/nn_*.py` | ~5,000 | Model training/inference |
| Database | PostgreSQL 15 | `localhost:5432` | — | 3.3GB, 4M+ rows |

### Services

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| API Server | 3008 | HTTP | REST API endpoints |
| PostgreSQL | 5432 | TCP | Database |
| Nominatim | External | HTTP | Geocoding |
| Gemma | 192.168.1.3:8888 | HTTP | AI extraction |
| Claude | External | HTTP | AI fallback |

### Processes

| Process | Type | Schedule | Purpose |
|---------|------|----------|---------|
| xyzo-api | systemd | Always | API server |
| xyzo-fast-fetcher | systemd timer | 5 min | Fast fetch cycle |
| xyzo-fetcher | systemd timer | 15 min | Full fetch cycle |
| xyzo-nn-infer | systemd timer | 5 min | NN inference |
| xyzo-nightly | systemd timer | 03:00 | Training, cleanup |
| xyzo-idle-worker | systemd | Always | Opportunistic work |

### Workers

| Worker | Slots | Timeout | Purpose |
|--------|-------|---------|---------|
| fetch | 4 | 30s | RSS/Atom polling |
| auto_categorize | 4 | 5s | Fast categorization |
| extract | 4 | 60s | AI extraction |
| geocode | 4 | 30s | Nominatim geocoding |
| cluster | 4 | 30s | Event clustering |
| explore_region | 2 | 75s | Source discovery |
| links_generate | 3 | 60s | Story linking |

### Queues

| Queue | Type | Capacity | Purpose |
|-------|------|----------|---------|
| discovery_jobs | Postgres | Unlimited | Worker job queue |
| nn_queue | In-memory | 100 | NN inference queue |
| event_bus | LISTEN/NOTIFY | — | Real-time updates |

### Databases

| Database | Size | Tables | Purpose |
|----------|------|--------|---------|
| xyzo | **59 GB** | 50+ | Main database (2026-10-05) |
| xyzo_cities | FDW | — | World cities gazetteer |

### Important Tables (2026-10-04)

| Table | Rows | Size | Purpose | Storage Strategy |
|-------|------|------|---------|------------------|
| city_story_features | 31.8M | 14 GB | Historical aggregates | Archive old data |
| news_articles | 1.6M | 9.6 GB | Articles | **Drop `body`**, keep `word_freq` |
| news_story_links | ? | 9 GB | Link graph | Keep |
| news_term_df | ? | 8.7 GB | TF-IDF data | Regenerate from `word_freq` |
| nn_article_embeddings | 1.6M | 1056 MB | 768-dim article embeddings | **KEEP** - expensive to regenerate |
| nn_training_features | ? | 1.6 GB | NN training data | **KEEP** |
| nn_prediction_cache | ? | 2.8 GB | NN prediction cache | **KEEP** |
| news_events | ? | 836 MB | Clustered events | Keep |
| news_sources | 4K | 652 MB | Source registry | Keep |
| news_locations | ? | 664 MB | Geocoded places | Keep |

> **Storage Strategy:** Drop `body` column to save ~1.3 GB. NN data (7 GB) is expensive to regenerate - keep it.
> See README.md "Database Storage Strategy" section for details.

### Major APIs

| Endpoint | Method | Purpose | P50 Latency |
|----------|--------|---------|-------------|
| /api/pins | GET | Pin list | 0.16ms |
| /api/pins/map | GET | Pin map (bbox) | 0.41ms |
| /api/feed/live | GET | Live feed | 66ms |
| /api/events/search | POST | Event search | <100ms |
| /api/geocode | GET | Geocoding | 0.09ms |
| /api/locations/search | GET | Location search | 77ms |
| /api/analytics/stats | GET | Analytics stats | <50ms |

### Frontend Subsystems

| Subsystem | LOC | Purpose |
|-----------|-----|---------|
| app.js | 13,823 | Main SPA logic |
| styles.css | 5,617 | Styling |
| analytics.js | 534 | Usage tracking |
| city-engine.js | ~500 | City detection |
| feedback-dialog.js | 248 | User feedback |
| flag-quality.js | 404 | Quality reports |

### AI Models

| Model | Architecture | Input | Output | Status |
|-------|-------------|-------|--------|--------|
| article_understanding | DistilBERT→Linear | Text | 16-dim embedding | ⚠️ No labels |
| geolocation | MLP | Text+meta | lat/lng/conf | ⚠️ No labels |
| entity_extraction | Conv1D | Text | BIO labels | ⚠️ No labels |
| event_matching | Siamese | Two texts | Similarity | ⚠️ No labels |
| relationship | Siamese | Two events | 8 relation types | ⚠️ No labels |
| ranking | MLP | Article+session | Score | ⚠️ No labels |
| coverage | MLP | Country features | Gap score | ⚠️ No labels |
| category_classifier | WordFreqNN | Word freq | 35 categories | ✅ Trained |

### Neural Networks

| Network | Parameters | Input Dim | Output Dim | Framework |
|---------|------------|-----------|------------|-----------|
| article_understanding | ~68M | 768 | 16 | PyTorch |
| geolocation | ~50K | 86 | 5 | PyTorch |
| category_classifier | ~2.1M | 8192 | 35 | PyTorch + sklearn |

### Embedding Models

| Model | Dim | Framework | Purpose |
|-------|-----|-----------|---------|
| distilbert-base-nli-stsb | 768→16 | sentence-transformers | Article embeddings |
| all-MiniLM-L6-v2 | 384 | sentence-transformers | Event dedup |

### Ranking Systems

| System | Formula | Purpose |
|--------|---------|---------|
| nn_ranking | Neural score | Article hotness |
| classical_engagement | Click/view ratio | User engagement |
| freshness | Time decay | Recency |
| velocity | Rate of change | Breaking news |
| source_quality | Reliability score | Source trust |
| coverage_gap | Geographic need | Under-covered areas |
| geo_spread | Diversity | Geographic spread |

### Geocoders

| Geocoder | Source | Rate Limit | Purpose |
|----------|--------|------------|---------|
| Nominatim | OpenStreetMap | 1 req/s | Forward geocoding |
| GeoIP | MaxMind | — | IP geolocation |
| CityEngine | DB lookup | — | Text city detection |

### Caches

| Cache | Type | Size | TTL | Purpose |
|-------|------|------|-----|---------|
| pins_cache | In-memory LRU | 1000 | 60s | Pin responses |
| ai_cache | Postgres | 5K rows | 24h | AI extraction results |
| nn_prediction_cache | Postgres | — | 6h | NN predictions |
| RobotsCache | In-memory | — | 24h | robots.txt cache |

### Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| xyzo-fast-fetcher | 5 min | Fast fetch cycle |
| xyzo-fetcher | 15 min | Full fetch cycle |
| xyzo-nn-infer | 5 min | NN inference |
| xyzo-nightly | 03:00 | Training, cleanup |
| xyzo-story-link | 6h | Story linking |
| xyzo-embeddings | 2h | Embedding generation |
| xyzo-queue-soak | 09:30 | Queue monitoring |

### External Dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| Nominatim | HTTP API | Geocoding |
| Gemma (local) | HTTP API | AI extraction |
| Claude (external) | HTTP API | AI fallback |
| DuckDuckGo | HTTP API | Search fallback |
| Google News RSS | HTTP API | News search |

### Data Pipelines

| Pipeline | Input | Output | Frequency |
|----------|-------|--------|-----------|
| fetch → extract → geocode → cluster | RSS feeds | news_events | 5-15 min |
| nn_infer → embeddings | news_articles | nn_article_embeddings | 5 min |
| nn_infer → predictions | news_articles | nn_prediction_cache | 5 min |
| story_linker | news_events | news_story_links | 6h |
| learn | news_interactions | news_sources rankings | Daily |

### User Behavior Entry Points

| Entry Point | Data Collected | Purpose |
|-------------|----------------|---------|
| /api/analytics/log | Interaction type, location | Usage tracking |
| /api/analytics/set-home | User location | GeoIP |
| /api/feedback/suggest | User suggestions | Quality |
| /api/searches/save | Saved searches | Personalization |
| /api/articles/:id/apply-categorization | Category corrections | Learning |

### Intelligence Surfaces

| Surface | Data | Learning Loop |
|---------|------|---------------|
| Search queries | Query text, results | Search expansion |
| Pin clicks | Article clicks | Ranking improvement |
| Map movements | Viewport changes | Coverage gaps |
| User corrections | Category/location fixes | Model retraining |
| Source reliability | Fetch success/failure | Source ranking |
| Event clustering | Article grouping | Dedup improvement |
