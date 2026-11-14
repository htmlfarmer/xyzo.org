# XYZO Schema Organization

This directory organizes schema files by domain for easier navigation.
The actual schema files remain in `../` (api/) for backward compatibility.

## Domain Groups

### Core (foundation tables)
| File | Purpose |
|------|---------|
| `../schema.sql` | Base pins table |
| `../schema-events.sql` | news_sources, news_articles, news_events, news_locations |
| `../schema-cities.sql` | world_cities table |
| `../schema-auto-categorize.sql` | Fast-path categorization columns on news_articles |
| `../schema-icons.sql` | Extended category vocabulary |

### Location / Geocoding
| File | Purpose |
|------|---------|
| `../schema-sources-geo.sql` | Source geocoding (once per source, not per article) |
| `../schema-geo-resolver.sql` | Geolocation decision audit trail |

### Content Ingestion
| File | Purpose |
|------|---------|
| `../schema-audio.sql` | audio_shows, audio_episodes |
| `../schema-video.sql` | video_channels, videos |
| `../schema-photo-sources.sql` | photo_sources |
| `../schema-feed-submissions.sql` | User-submitted source queue |

### AI / ML Pipeline
| File | Purpose |
|------|---------|
| `../schema-neural-networks.sql` | NN training layer |
| `../schema-nn-embeddings.sql` | Article/event embedding caches |
| `../schema-nn-optimize.sql` | Batch inference queue, fast aggregates |
| `../schema-nn-predictions.sql` | Prediction views |
| `../schema-nn-rankings.sql` | Ranking features from interaction history |
| `../schema-ai-flags.sql` | AI-assisted flag reports |

### Community / User Content
| File | Purpose |
|------|---------|
| `../schema-community.sql` | Community validation (votes, replies) |
| `../schema-feedback.sql` | Geocoding correction feedback |
| `../schema-reports-access.sql` | Quality reports (paywall, login_required) |

### Learning / Feedback Loop
| File | Purpose |
|------|---------|
| `../schema-learning.sql` | fetch_decisions, coverage_gaps, extraction_feedback |
| `../schema-evolution.sql` | Story evolution stages, mutation tracking |
| `../schema-undercovered.sql` | Events heavily covered locally but not internationally |

### People / Organizations
| File | Purpose |
|------|---------|
| `../schema-authors.sql` | news_article_authors |
| `../schema-journalists.sql` | Journalist profiles |
| `../schema-science-sources.sql` | Curated science universe |
| `../schema-news-deserts.sql` | Places with low news coverage |
| `../schema-news-requests.sql` | User area discovery requests |

### Analytics
| File | Purpose |
|------|---------|
| `../schema-analytics.sql` | User interactions, source rankings |
| `../schema-location-views.sql` | Map view tracking for discovery prioritization |
| `../schema-syndication.sql` | Article ancestry and original reporting detection |

### Source Management
| File | Purpose |
|------|---------|
| `../schema-source-profiles.sql` | Missing columns and profiling infrastructure |
| `../schema-article-cities.sql` | Cities mentioned in articles (for coverage stats) |

## Migration Order

When running fresh migrations, apply in this order:

1. **Core first** (establishes foundation)
2. **Location** (depends on core)
3. **Content Ingestion** (depends on core + location)
4. **AI/ML** (depends on core)
5. **Learning** (depends on core + AI/ML)
6. **Community** (depends on core)
7. **People** (depends on core)
8. **Analytics** (depends on core)
9. **Source Management** (depends on core)

## Adding New Schemas

1. Place the schema file in `../` with the naming convention `schema-<feature>.sql`
2. Add an entry in the appropriate domain group above
3. Document the purpose and any dependencies in the schema file header
