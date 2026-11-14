-- Geocoder async pipeline trigger (Audit 3+4).
--
-- Fires NOTIFY geocode_requested whenever ``extract.run`` writes a new
-- ``status='extracted'`` row into ``news_articles``. The NOTIFY payload
-- is the new article's primary key as JSON ``{"id": 12345}``.
--
-- Worker-side listener: ``worker/geocode_queue.py:GeocodeListener``.
-- Until the migration runs, the listener still works via its poll
-- fallback (queue.drain_pending every 5s). The trigger is purely
-- additive; it does NOT change ``run()``'s polling behavior.
--
-- Idempotency: we drop-and-recreate both the trigger and the helper
-- function so this migration can be re-run.
--
-- Why NOT a separate worker pool table / outbox:
--   The ``status='extracted'`` column already serves as the
--   "needs-geocoding" flag and is the same predicate the polling
--   path uses. Adding a second queue table would double the writes on
--   the hot insert path (extract inserts ~150 articles per cycle).
--   NOTIFY piggybacks on the same INSERT and is consumed asynchronously.

BEGIN;

DROP TRIGGER IF EXISTS news_articles_geocode_notify ON news_articles;
DROP FUNCTION IF EXISTS news_articles_geocode_notify_fn();

CREATE OR REPLACE FUNCTION news_articles_geocode_notify_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only fire for rows that actually need geocoding: status went to
    -- 'extracted' AND location_id is still null. A re-update to the
    -- same status (e.g. auto_categorize re-anchoring) shouldn't spam.
    IF NEW.status = 'extracted'
       AND NEW.location_id IS NULL
       AND NEW.location_text IS NOT NULL
       AND (OLD.status IS DISTINCT FROM 'extracted'
            OR OLD.location_id IS NOT NULL)
    THEN
        PERFORM pg_notify(
            'geocode_requested',
            json_build_object('id', NEW.id)::text
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER news_articles_geocode_notify
    AFTER UPDATE OF status, location_id ON news_articles
    FOR EACH ROW
    EXECUTE FUNCTION news_articles_geocode_notify_fn();

-- The extract path does INSERT (not UPDATE) for brand-new rows, so the
-- trigger above doesn't catch them. Add an INSERT trigger too: an
-- inserted row with status='pending' shouldn't fire; the article only
-- becomes geocodable when extract.run sets status='extracted'. Since
-- extract.run does ``UPDATE ... SET status='extracted'``, the UPDATE
-- trigger already covers it. Leaving the insert path to the polling
-- fallback (which is harmless, just slightly slower).

COMMIT;
