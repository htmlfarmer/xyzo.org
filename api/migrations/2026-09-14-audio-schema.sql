-- Audio schema migration — apply schema-audio.sql
-- Run: psql $XYZO_DB_URL -f api/migrations/2026-09-14-audio-schema.sql
-- Idempotent (IF NOT EXISTS everywhere).

\i api/schema-audio.sql
