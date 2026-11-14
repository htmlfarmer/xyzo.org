-- ── 2026-09-07-classifier-runs.sql ─────────────────────────────────
--
-- History of classifier training runs. Each row = one model training
-- cycle. We keep the model binary on disk and point `model_path` at it.
--
-- The classifier has two heads (re-ranker + event type). Metrics:
--   auc     — ROC AUC for the re-ranker
--   rmse    — root-mean-square error of the re-ranker
--   f1      — macro F1 for the event-type head
--   status  — 'ok' (deployed) | 'rejected' (quality regressed)
--
-- Newer ok rows are loaded on demand; rejected runs are kept for audit.

BEGIN;

CREATE TABLE IF NOT EXISTS classifier_runs (
    id              BIGSERIAL PRIMARY KEY,
    trained_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sample_count    INTEGER NOT NULL,
    new_samples     INTEGER NOT NULL,
    auc             REAL,
    rmse            REAL,
    f1              REAL,
    status          TEXT NOT NULL,
    model_path      TEXT,
    notes           TEXT,
    CONSTRAINT classifier_runs_status_check
        CHECK (status IN ('ok', 'rejected', 'training'))
);

CREATE INDEX IF NOT EXISTS classifier_runs_status_idx
    ON classifier_runs (status, trained_at DESC)
    WHERE status = 'ok';

CREATE INDEX IF NOT EXISTS classifier_runs_trained_idx
    ON classifier_runs (trained_at DESC);

COMMIT;
