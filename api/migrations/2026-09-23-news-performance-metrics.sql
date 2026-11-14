-- news_performance_metrics — used by src/metrics.ts to log and aggregate
-- CPU/GPU time for operations across the platform (API endpoints, AI
-- inference, worker processing). The table was referenced by queries
-- but never created; the /api/performance/public-* endpoints 500'd
-- on first hit. Created 2026-09-23.
CREATE TABLE IF NOT EXISTS news_performance_metrics (
  id             BIGSERIAL PRIMARY KEY,
  operation      TEXT        NOT NULL,
  endpoint       TEXT,
  duration_ms    DOUBLE PRECISION NOT NULL,
  cpu_time_ms    DOUBLE PRECISION,
  gpu_time_ms    DOUBLE PRECISION,
  memory_mb      DOUBLE PRECISION,
  session_id     TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Most queries filter by created_at (window queries) and group by
-- operation or endpoint. Composite indexes serve both access paths.
CREATE INDEX IF NOT EXISTS news_performance_metrics_created_at_idx
  ON news_performance_metrics (created_at DESC);
CREATE INDEX IF NOT EXISTS news_performance_metrics_operation_created_idx
  ON news_performance_metrics (operation, created_at DESC);
CREATE INDEX IF NOT EXISTS news_performance_metrics_endpoint_created_idx
  ON news_performance_metrics (endpoint, created_at DESC)
  WHERE endpoint IS NOT NULL;
