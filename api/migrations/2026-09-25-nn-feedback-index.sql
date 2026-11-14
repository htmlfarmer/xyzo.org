-- Performance index for nn_feedback lookups in pins.ts
-- Both queries in pins.ts filter by feedback_target_type='article' and feedback_target_id
-- but NOT by model_name, so feedback_target_type should be the leading column.

-- Create optimized index: feedback_target_type leading, then feedback_target_id
-- Includes valid_until and created_at for the WHERE and ORDER BY clauses
-- KEEPS the old nn_feedback_target_idx intact since it may be used by other queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nn_feedback_article_lookup
ON nn_feedback (feedback_target_type, feedback_target_id, valid_until, created_at DESC)
WHERE feedback_target_type = 'article';

-- Also add a partial index for the common case where valid_until > NOW()
-- This helps the "most recent feedback" queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nn_feedback_active
ON nn_feedback (feedback_target_type, feedback_target_id, created_at DESC)
WHERE feedback_target_type = 'article' AND valid_until > NOW();
