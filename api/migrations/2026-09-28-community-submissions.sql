-- 2026-09-28 (pm): click-to-submit community stories + two-stage moderation.
--
-- Stage 1 (sync, in POST /api/pins): deterministic fast scan — spam/gibberish
--   heuristics, multilingual lite topic classification, coordinate sanity,
--   near-duplicate check. Result stored in mod_fast. Pass → published.
-- Stage 2 (deferred, community_triage queue → worker/pin_moderate.py):
--   word_freq language/doc-type analysis, robots.txt + bounded fetch of any
--   submitted URL, frequency analysis, then a breaker-gated LLM verdict
--   (only when the AI box is free). Result stored in mod_deep; an LLM
--   rejection flips pins.status to 'hidden'.
--
-- Anonymous submissions: name/email no longer required (API defaults name
-- to 'Anonymous'), so both columns lose NOT NULL.

ALTER TABLE community_details ALTER COLUMN submitter_name DROP NOT NULL;
ALTER TABLE community_details ALTER COLUMN submitter_email DROP NOT NULL;

ALTER TABLE community_details ADD COLUMN IF NOT EXISTS story_note TEXT;
ALTER TABLE community_details ADD COLUMN IF NOT EXISTS submitter_ip INET;

-- Moderation audit trail
ALTER TABLE community_details ADD COLUMN IF NOT EXISTS mod_fast JSONB;
ALTER TABLE community_details ADD COLUMN IF NOT EXISTS mod_deep JSONB;
ALTER TABLE community_details ADD COLUMN IF NOT EXISTS mod_status TEXT
  NOT NULL DEFAULT 'fast_published'
  CHECK (mod_status IN (
    'fast_published',    -- passed sync fast scan; deep check queued or skipped
    'deep_ok',           -- deep scan + LLM (or deep-only) confirmed
    'deep_ok_no_llm',    -- deep scan ran, LLM unavailable/busy — still fine
    'rejected',          -- deep scan or LLM rejected → pin hidden
    'uncertain'          -- LLM unsure → stays published, flagged for humans
  ));

CREATE INDEX IF NOT EXISTS community_details_mod_status_idx
  ON community_details (mod_status) WHERE mod_status IN ('rejected', 'uncertain');

GRANT SELECT, INSERT, UPDATE ON community_details TO xyzo_app;
