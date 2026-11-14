-- Adds synthetic test kinds to the job_kind enum. These back the Python
-- handlers registered in worker.dispatcher as 'test_noop' / 'test_sleep'
-- and are used exclusively by api/tests/queue/integration.test.ts.
--
-- Idempotent: ALTER TYPE ADD VALUE IF NOT EXISTS is supported on PG 12+
-- and guards against re-runs.

ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'test_noop';
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'test_sleep';
