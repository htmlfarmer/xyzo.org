-- What readers actually use, so the map can be built from evidence
-- rather than from guesses.
--
-- TWO questions this answers:
--
--   1. WHICH OVERLAYS are worth putting where in the layers dropdown.
--      The dropdown is ~40 rows; a reader has to scroll to find the
--      one they want. Ordering it by how often each row is actually
--      switched on puts the useful ones at the top.
--
--   2. WHAT A "STORM WATCH" MAP LOOKS LIKE to the people who open one.
--      The Cool maps presets are hand-authored today. Once there is
--      enough data, each preset's layers and opacities can be compared
--      with what people who apply it then change — the preset becomes
--      a starting point that is measured, not a guess.
--
-- ONE ROW PER SESSION PER DAY PER SETTING, so a session that flips
-- twenty overlays still counts once each. The aggregate is computed on
-- read with COUNT(DISTINCT session_id) — no counter to corrupt, no
-- race between two tabs of the same browser.
--
-- `pct` is the opacity 0..100 where the setting HAS one (an overlay)
-- and NULL where it does not (a base layer, a preset, a density).
--
-- Nothing here identifies a person: the session id is the random
-- localStorage key analytics.js has always used, and no IP is stored.
-- `scripts/retention_prune.py` prunes it with the other telemetry.
--
-- Applied 2026-11-05.

CREATE TABLE IF NOT EXISTS map_settings_usage (
    day        DATE        NOT NULL DEFAULT current_date,
    session_id TEXT        NOT NULL,
    kind       TEXT        NOT NULL,
    key        TEXT        NOT NULL,
    -- The display name as the layers dropdown shows it. The slug is the
    -- stable identity (it survives a rename); the name is what the
    -- reader sees, and the report and the row ordering match on it.
    name       TEXT,
    pct        SMALLINT,
    reason     TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A surrogate id, because `scripts/retention_prune.py` prunes by
    -- `id` and every other telemetry table it touches has one. The
    -- NATURAL key is (day, session_id, kind, key) and it is a UNIQUE
    -- index, so the write stays idempotent.
    id         BIGSERIAL   PRIMARY KEY
);

CREATE UNIQUE INDEX IF NOT EXISTS map_settings_usage_natural_key
    ON map_settings_usage (day, session_id, kind, key);

COMMENT ON TABLE map_settings_usage IS
  'One row per session per day per map setting: which overlays a
   reader had on and at what opacity, which preset they opened, which
   base layer. Used to order the layers dropdown by real use and to
   check the curated presets against what people actually choose.';

-- The aggregate reads (day, kind, key) over a window.
CREATE INDEX IF NOT EXISTS map_settings_usage_day_kind_key
    ON map_settings_usage (day, kind, key);

-- And the report asks "what did THIS session settle on today".
CREATE INDEX IF NOT EXISTS map_settings_usage_session_day
    ON map_settings_usage (session_id, day);

-- `key` is a layer slug, a preset id or a setting name — never free
-- text from the client beyond that. A CHECK keeps it that way.
ALTER TABLE map_settings_usage
    ADD CONSTRAINT map_settings_usage_kind_check
    CHECK (kind IN ('overlay', 'preset', 'base', 'setting'));

ALTER TABLE map_settings_usage
    ADD CONSTRAINT map_settings_usage_pct_check
    CHECK (pct IS NULL OR (pct >= 0 AND pct <= 100));
