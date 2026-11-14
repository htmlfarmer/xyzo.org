-- ── 2026-09-06-events-schema-extend.sql ──────────────────────────────
--
-- Schema extension for upcoming_events based on the user's column list
-- (2026-09-06):
--
--   event_id              -- renamed to `id` (BIGSERIAL PRIMARY KEY)
--   title, description    -- already present
--   event_type            -- NEW: 'in-person' | 'online' | 'hybrid'
--   category              -- already present (top-level bucket)
--   subcategory           -- NEW: free-text drill-down e.g. 'ai', 'rock', 'ml'
--
--   start_datetime        -- renamed to `starts_at` (TIMESTAMPTZ — UTC-normalized)
--   end_datetime          -- renamed to `ends_at`   (TIMESTAMPTZ)
--   timezone              -- NEW: IANA tz string from source, e.g. 'America/Los_Angeles'
--                            Stored alongside the UTC `starts_at` so the UI can
--                            render either absolute UTC or local-to-venue time.
--
--   venue_name, venue_address  -- already present
--   city, state, country, latitude, longitude
--                            -- `state` is NEW; we previously had `region`
--                               which was overloaded (US state vs. province).
--                               Keeping `region` as a denormalized copy so
--                               old queries keep working.
--                            -- lat/lng columns keep their existing names for
--                               query-plan stability (GiST indexes already
--                               reference them) — see upcoming_events_geo_idx.
--
--   organizer, organizer_url   -- `organizer_name` already exists; we add
--                                `organizer_url`.
--
--   event_url             -- we have `source_url` already (the canonical
--                            URL of the event on the source platform).
--                            Adding `canonical_url` (post-redirect, deduped).
--   source_url            -- already present (feed URL on the source platform)
--   source_domain         -- NEW: hostname extracted from source_url — used
--                            for grouping, dedup, and politeness.
--
--   price                 -- we have `price_min`/`price_max`. Adding a
--                            single `price` for events that quote one number.
--   currency, is_free     -- already present
--   registration_url      -- NEW: URL to register / buy tickets (often
--                            different from event_url)
--
--   speaker_names         -- NEW: TEXT[] (conferences, lectures)
--   artist_names          -- NEW: TEXT[] (concerts, festivals)
--   performer_names       -- NEW: TEXT[] (generic)
--
--   tags                  -- already present (TEXT[])
--   keywords              -- NEW: TEXT[] — normalized keywords for search
--                            and dedup (stems, lowercase, dedup'd)
--
--   image_url             -- already present
--
--   discovered_at         -- NEW: first time we saw this event
--   updated_at            -- already present (auto-maintained by trigger)
--   last_seen_at          -- NEW: last time we observed this event in a
--                            feed poll. Used to mark events stale when
--                            they vanish from feeds.
--
--   source_priority       -- NEW: 1-20 from the user's priority table.
--                            Higher = more trustworthy / preferred when
--                            the same event shows up from multiple sources.
--   crawl_status          -- NEW: 'ok' | 'redirect' | '404' | '403' |
--                            '429' | 'parse_error' | 'blocked_robots'
--   robots_allowed        -- NEW: BOOLEAN — last observed robots.txt verdict
--
--   canonical_url         -- NEW: post-redirect, normalised URL. Dedup key
--                            across sources.
--   content_hash          -- NEW: SHA256 of title+description+starts_at
--                            — used for fuzzy dedup across sources.
--
-- Adds new indexes only where queries would benefit. The existing
-- starts_at / city / country / category / geo / FTS indexes are
-- untouched. The new fields are mostly denormalized metadata for
-- filtering and display.

BEGIN;

-- ── event_type: distinguish format from topical category ─────────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS event_type  TEXT,
    ADD COLUMN IF NOT EXISTS subcategory TEXT;

ALTER TABLE upcoming_events
    ADD CONSTRAINT upcoming_events_event_type_check
        CHECK (event_type IS NULL OR event_type IN ('in-person','online','hybrid'))
        NOT VALID;  -- won't scan existing rows; we'll trust new rows

-- ── timezone (IANA) and a denormalized state column ─────────────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS timezone TEXT,
    ADD COLUMN IF NOT EXISTS state    TEXT;

-- Backfill state from region for legacy rows where region looks like a
-- US state abbreviation (2 chars, uppercase).
UPDATE upcoming_events
SET state = region
WHERE state IS NULL AND region IS NOT NULL
  AND length(region) = 2 AND region = upper(region)
  AND region IN (
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV',
    'NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
    'TX','UT','VT','VA','WA','WV','WI','WY','DC'
  );

-- ── organizer + source_domain + canonical_url + content_hash ────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS organizer_url  TEXT,
    ADD COLUMN IF NOT EXISTS source_domain  TEXT,
    ADD COLUMN IF NOT EXISTS canonical_url  TEXT,
    ADD COLUMN IF NOT EXISTS content_hash   TEXT;

-- Backfill source_domain from source_url for existing rows.
UPDATE upcoming_events
SET source_domain = lower(split_part(split_part(source_url, '://', 2), '/', 1))
WHERE source_domain IS NULL AND source_url IS NOT NULL;

UPDATE upcoming_events
SET canonical_url = source_url
WHERE canonical_url IS NULL AND source_url IS NOT NULL;

-- ── price (single) + registration_url ───────────────────────────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS price            NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS registration_url TEXT;

-- Backfill price from price_min when only one bracket is set.
UPDATE upcoming_events
SET price = price_min
WHERE price IS NULL AND price_min IS NOT NULL AND price_max IS NULL;

-- ── people arrays ───────────────────────────────────────────────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS speaker_names   TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS artist_names    TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS performer_names TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS keywords        TEXT[] NOT NULL DEFAULT '{}';

-- ── discovery lifecycle ─────────────────────────────────────────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ;

UPDATE upcoming_events
SET discovered_at = COALESCE(discovered_at, fetched_at),
    last_seen_at  = COALESCE(last_seen_at,  fetched_at)
WHERE discovered_at IS NULL OR last_seen_at IS NULL;

-- ── source_priority, crawl_status, robots_allowed ──────────────────
ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS source_priority SMALLINT,
    ADD COLUMN IF NOT EXISTS crawl_status    TEXT NOT NULL DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS robots_allowed  BOOLEAN NOT NULL DEFAULT TRUE;

-- ── indexes for the new query patterns ────────────────────────────
-- Source priority filtering (e.g. "show only Tier 1 sources first").
CREATE INDEX IF NOT EXISTS upcoming_events_priority_starts_idx
    ON upcoming_events (source_priority, starts_at)
    WHERE source_priority IS NOT NULL;

-- Source-domain grouping (e.g. "show everything from eventbrite.com").
CREATE INDEX IF NOT EXISTS upcoming_events_source_domain_idx
    ON upcoming_events (source_domain, starts_at)
    WHERE source_domain IS NOT NULL;

-- Event-type filtering.
CREATE INDEX IF NOT EXISTS upcoming_events_event_type_idx
    ON upcoming_events (event_type, starts_at)
    WHERE event_type IS NOT NULL;

-- State-level filtering.
CREATE INDEX IF NOT EXISTS upcoming_events_state_idx
    ON upcoming_events (state, starts_at)
    WHERE state IS NOT NULL;

-- Content-hash dedup. Useful when two sources list the same event.
CREATE INDEX IF NOT EXISTS upcoming_events_content_hash_idx
    ON upcoming_events (content_hash)
    WHERE content_hash IS NOT NULL;

-- Stale-event cleanup job: find rows not seen in N days.
CREATE INDEX IF NOT EXISTS upcoming_events_last_seen_idx
    ON upcoming_events (last_seen_at)
    WHERE last_seen_at IS NOT NULL;

COMMIT;

-- ── View: events_with_source_priority ─────────────────────────────
-- Joins upcoming_events with the source-priority table when it exists,
-- so the API can sort Tier-1 sources first without the client needing
-- to know about source ids.
--
-- (Created in a separate migration once the source_priority table is
--  populated from the user's priority list.)
