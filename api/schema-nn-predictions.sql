-- Xyzo Neural Network prediction views. Additive, idempotent.
--
-- The API never reads nn_prediction_cache directly; it reads through
-- these views so the per-model semantics are in one place and we can
-- change the cache layout without breaking the API.
--
-- Canonical 7-model taxonomy (see docs/neural-networks.md):
--   1. article_understanding  — text encoder; emits embeddings cached in
--                                nn_article_embeddings. (No prediction view —
--                                the embedding IS the output.)
--   2. entity_extraction      — BIO tagger. Cached as token offsets + classes
--                                on news_articles.entities (legacy) and
--                                nn_article_entities (new, richer).
--   3. geolocation            — multi-input regression + classification
--                                (lat, lng, precision, confidence).
--   4. event_matching         — pair scores cached in nn_event_pair_predictions.
--   5. relationship           — edge scores cached in nn_event_relationships.
--   6. ranking                — per-article score; cached view below.
--   7. coverage               — per-country / per-city score + recommended sources.
--
-- Pattern: each view returns one row per (entity) with the latest
-- non-stale prediction from the active model version. JOINs to the
-- nn_model_registry so we always know which version produced it.
--
-- Naming convention: nn_v_<model_name> for the latest-only view.


-- NOTE: there is no nn_v_geolocation view. The geolocation NN was removed
-- on 2026-10-26 — it never placed an article (the predictions were written
-- to nn_prediction_cache and read by nothing), and the classical pipeline
-- (auto_categorize → extract → geocode → place_disambiguation) is what
-- puts coordinates on the map. Do not recreate this view without first
-- building a real evaluation and a write-back path into
-- news_articles.extracted_lat/lng.


-- ── 6. Ranking ────────────────────────────────────────────────────
-- Per-article ranking score. Inputs: article embedding (cosine) × user
-- session aggregate × source NN-quality × freshness × location proximity.
-- Output: scalar score in [0,1]; the API then blends with classical
-- engagement_score (0.7 NN / 0.3 classical) for the leaderboard.
CREATE OR REPLACE VIEW nn_v_ranking AS
SELECT
    pc.entity_type,                                     -- 'article' | 'event'
    pc.entity_id,
    pc.score                                            AS ranking_score,
    (pc.score_aux->>'trending_score')::FLOAT            AS trending_score,
    (pc.score_aux->>'local_relevance')::FLOAT           AS local_relevance,
    (pc.score_aux->>'source_quality')::FLOAT            AS source_quality,
    (pc.score_aux->>'freshness')::FLOAT                 AS freshness,
    (pc.score_aux->>'velocity')::FLOAT                  AS velocity,           -- Δclicks/hour, normalized
    (pc.score_aux->>'audience_match')::FLOAT            AS audience_match,     -- for global ranking
    (pc.score_aux->>'bucket')::TEXT                     AS bucket,             -- 'hot' | 'trending' | 'rising' | 'normal'
    pc.predicted_at,
    pc.valid_until,
    pc.model_version
FROM nn_prediction_cache pc
JOIN nn_model_registry r
  ON r.model_name = pc.model_name AND r.is_active = TRUE
WHERE pc.model_name = 'ranking'
  AND pc.valid_until > now();


-- ── 7. Coverage ───────────────────────────────────────────────────
-- Per-country (and per-city) under-coverage score + recommended next
-- sources to onboard. The output is consumed by worker/immediate_discover.py
-- to bias source discovery toward underrepresented areas.
CREATE OR REPLACE VIEW nn_v_coverage AS
SELECT
    pc.entity_id,
    pc.entity_type,                                     -- 'country' | 'city'
    pc.score                                            AS coverage_gap_score,
    (pc.score_aux->>'recommended_sources')::INT         AS recommended_sources,
    (pc.score_aux->>'expected_yield_per_source')::FLOAT AS expected_yield_per_source,
    (pc.score_aux->>'languages')::TEXT                  AS languages,         -- csv of ISO 639-1
    (pc.score_aux->>'feed_url_hints')::TEXT             AS feed_url_hints,    -- csv of suggested hostnames
    (pc.score_aux->>'confidence')::FLOAT                AS confidence,
    (pc.score_aux->>'reasoning')::TEXT                  AS reasoning,
    pc.predicted_at,
    pc.valid_until,
    pc.model_version,
    -- Joined classical context
    g.country_code,
    g.country_name,
    g.gap_score                                         AS classical_gap_score,
    g.events_per_million_24h,
    g.population
FROM nn_prediction_cache pc
JOIN nn_model_registry r
  ON r.model_name = pc.model_name AND r.is_active = TRUE
LEFT JOIN news_coverage_gaps g ON g.id = pc.entity_id
WHERE pc.model_name = 'coverage'
  AND pc.entity_type IN ('country', 'city')
  AND pc.valid_until > now();


-- ── Hot-path view: ranked articles by NN ranking ─────────────────
-- Article leaderboard used by /api/articles/hot, /api/articles/trending.
-- Blends NN ranking with classical engagement.
CREATE OR REPLACE VIEW nn_v_article_leaderboard AS
SELECT
    a.id                                                AS article_id,
    a.title,
    a.source_id,
    s.name                                              AS source_name,
    s.country                                           AS source_country,
    r.ranking_score                                     AS nn_ranking_score,
    r.trending_score,
    r.local_relevance,
    r.source_quality,
    r.bucket                                            AS nn_bucket,
    COALESCE(rnk.engagement_score, 0)                   AS classical_engagement,
    -- 0.65 NN ranking + 0.25 classical engagement + 0.10 freshness proxy
    (0.65 * COALESCE(r.ranking_score, 0.5)
     + 0.25 * LEAST(COALESCE(rnk.engagement_score, 0) / 50.0, 1.0)
     + 0.10 * (1.0 - LEAST(EXTRACT(EPOCH FROM (now() - a.published_at)) / 86400.0, 1.0))
    )                                                   AS blended_score,
    a.published_at,
    a.fetched_at,
    l.lat,
    l.lng,
    l.country                                           AS article_country,
    l.place_name,
    l.confidence                                        AS geocode_confidence
FROM news_articles a
JOIN news_sources s ON s.id = a.source_id
LEFT JOIN news_locations l ON l.id = a.location_id
LEFT JOIN nn_v_ranking r
       ON r.entity_type = 'article' AND r.entity_id = a.id
LEFT JOIN news_source_rankings rnk ON rnk.source_id = a.source_id
WHERE a.status = 'extracted'
  AND s.active = TRUE
  AND COALESCE(l.lat, 999) BETWEEN -90 AND 90;


-- ── Training-set summary view ─────────────────────────────────────
CREATE OR REPLACE VIEW nn_v_training_summary AS
SELECT
    tf.model_name,
    et.description                                      AS entity_type,
    COUNT(*)                                            AS total_rows,
    COUNT(*) FILTER (WHERE tf.label IS NOT NULL)        AS labeled_rows,
    COUNT(*) FILTER (WHERE tf.label IS NULL)            AS unlabeled_rows,
    AVG(tf.label) FILTER (WHERE tf.label IS NOT NULL)   AS avg_label,
    MIN(tf.snapshot_at)                                 AS first_snapshot,
    MAX(tf.snapshot_at)                                 AS latest_snapshot,
    COUNT(DISTINCT tf.dataset_hash)                     AS dataset_versions
FROM nn_training_features tf
JOIN nn_entity_types et ON et.slug = tf.entity_type
GROUP BY tf.model_name, et.description;


-- ── Model registry view (latest active per model) ────────────────
CREATE OR REPLACE VIEW nn_v_active_models AS
SELECT
    r.model_name,
    r.version,
    r.architecture,
    r.hyperparameters,
    r.metrics,
    r.artifact_path,
    r.trained_at,
    r.dataset_hash,
    COUNT(pc.id)                                        AS predictions_in_cache,
    COUNT(f.id)                                         AS feedback_since_train
FROM nn_model_registry r
LEFT JOIN nn_prediction_cache pc
       ON pc.model_name = r.model_name
      AND pc.model_version = r.version
LEFT JOIN nn_feedback f
       ON f.model_name = r.model_name
      AND f.created_at > r.trained_at
WHERE r.is_active = TRUE
GROUP BY r.id;


-- ── Convenience: one-row-per-model coverage of the NN layer ──────
-- Used by /api/nn/status to render the admin "neural system health" page.
CREATE OR REPLACE VIEW nn_v_system_status AS
SELECT
    am.model_name,
    am.version,
    am.trained_at,
    am.metrics,
    COALESCE(ts.labeled_rows, 0)                        AS labeled_rows,
    COALESCE(ts.total_rows, 0)                          AS total_rows,
    COALESCE(emb.embedding_count, 0)                    AS cached_embeddings,
    COALESCE(am.predictions_in_cache, 0)                AS predictions_in_cache,
    COALESCE(am.feedback_since_train, 0)                AS feedback_since_train,
    CASE
        WHEN am.model_name IS NULL                          THEN 'not_trained'
        WHEN COALESCE(ts.labeled_rows, 0) < 100             THEN 'cold_start'
        WHEN am.predictions_in_cache = 0                    THEN 'trained_no_inference'
        ELSE 'live'
    END                                                 AS lifecycle
FROM nn_entity_types et
LEFT JOIN nn_v_active_models am ON am.model_name = et.slug
LEFT JOIN nn_v_training_summary ts ON ts.model_name = et.slug
LEFT JOIN (
    SELECT 'article_understanding' AS model_name, COUNT(*) AS embedding_count
    FROM nn_article_embeddings
) emb ON emb.model_name = am.model_name
WHERE et.slug IN ('article_understanding', 'entity_extraction', 'geolocation',
                  'event_matching', 'relationship', 'ranking', 'coverage')
ORDER BY et.slug;


-- ── Permissions ──────────────────────────────────────────────────
GRANT SELECT ON nn_v_ranking,
                nn_v_coverage,
                nn_v_article_leaderboard,
                nn_v_training_summary,
                nn_v_active_models,
                nn_v_system_status
    TO xyzo_app;
