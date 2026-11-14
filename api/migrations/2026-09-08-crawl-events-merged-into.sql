-- ── 2026-09-08-crawl-events-merged-into.sql ─────────────────────────
--
-- Adds ``merged_into BIGINT REFERENCES upcoming_events(id)`` to
-- ``crawl_events`` so that cross-source dedup (Task 19 / P3.19) can
-- record that a crawled event has been merged into the canonical
-- ``upcoming_events`` row.
--
-- Why:
--   - ``crawl_events`` was created in 2026-09-06-site-crawl.sql without
--     any dedup bookkeeping. The pgvector dedup worker writes
--     ``merged_into`` when a near-duplicate pair is collapsed, and that
--     column did not exist — the UPDATE silently failed and the row
--     stayed visible as a duplicate.
--   - The 2026-09-07-embeddings.sql migration only added ``embedding``
--     and ``embedding_text``; it did not touch dedup metadata.
--   - The reference points at ``upcoming_events(id)`` because dedup
--     always collapses a ``crawl_events`` row INTO the canonical
--     upcoming row (the canonical row is kept, the crawl row is
--     retired). No reverse direction is recorded here.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it can be re-run safely.

BEGIN;

ALTER TABLE crawl_events
    ADD COLUMN IF NOT EXISTS merged_into BIGINT REFERENCES upcoming_events(id);

COMMIT;