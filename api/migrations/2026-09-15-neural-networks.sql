-- 2026-09-15 — Neural network training layer (initial)
--
-- Adds the schema for the PyTorch training pipeline:
--   schema-neural-networks.sql  — core tables (training_features, model_registry,
--                                  prediction_cache, feedback, training_runs)
--   schema-nn-embeddings.sql    — pgvector embedding caches + graph edges
--                                  (article/event/country/city embeddings,
--                                  event pair predictions, relationship edges)
--   schema-nn-predictions.sql   — nn_v_* views the API reads at request time
--   schema-nn-rankings.sql      — session/aggregated features for the
--                                  Ranking Model + hourly refresh functions
--
-- All four schema files are independently idempotent; this migration
-- sequences them so the views in -predictions can reference the tables
-- created in -neural-networks and -embeddings.
--
-- Depends on existing tables from:
--   schema-events.sql      — news_sources, news_articles, news_locations,
--                             news_events, news_event_sources
--   schema-analytics.sql   — news_interactions, news_coverage_gaps,
--                             news_source_rankings, news_user_locations
--   schema-feedback.sql    — news_re_evaluate_requests (referenced by
--                             nn_feedback via metadata.target_request_id)
--   schema-learning.sql    — news_fetch_decisions (used as feature input)
--
-- Run order is critical because of foreign-key dependencies:
--   1. schema-neural-networks.sql  — core tables, no cross-file FKs
--   2. schema-nn-embeddings.sql    — references news_articles, news_events,
--                                    news_locations, news_sources
--   3. schema-nn-predictions.sql   — views over the cache tables
--   4. schema-nn-rankings.sql      — references news_interactions,
--                                    news_user_locations, news_events

BEGIN;

\i /var/www/vhosts/xyzo.org/api/schema-neural-networks.sql
\i /var/www/vhosts/xyzo.org/api/schema-nn-embeddings.sql
\i /var/www/vhosts/xyzo.org/api/schema-nn-predictions.sql
\i /var/www/vhosts/xyzo.org/api/schema-nn-rankings.sql

-- Final permission sweep (covers any tables the individual files
-- might have missed in this migration).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO xyzo_app;

COMMIT;
