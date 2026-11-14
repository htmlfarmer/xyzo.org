-- schema-icons.sql
--
-- Widens pins.category to permit the finer-grained story-type vocabulary
-- defined in api/src/validate.ts (and matched by icons in
-- public_html/app.js EVENT_ICONS). The original 12 main categories are
-- preserved; we add ~45 sub-types so the AI extractor / clusterer can
-- choose a more specific icon per story.
--
-- news_articles.event_type and news_events.event_type were already free
-- TEXT (no CHECK constraint), so no change is needed there.
--
-- Run this migration AFTER schema.sql and schema-events.sql and
-- schema-feedback.sql.

-- Drop the old 12-value CHECK on pins.category and replace it with a
-- wider one. We list every allowed value explicitly to keep the data
-- well-typed; future additions should be appended here AND to
-- CATEGORIES in api/src/validate.ts.
ALTER TABLE pins DROP CONSTRAINT IF EXISTS pins_category_check;

ALTER TABLE pins ADD CONSTRAINT pins_category_check CHECK (
    category IN (
        -- Main buckets (kept from v1).
        'politics', 'business', 'crime', 'weather', 'science', 'technology',
        'sports', 'culture', 'environment', 'conflict', 'health', 'other',

        -- Politics sub-types.
        'elections', 'courts', 'policy', 'diplomacy', 'protest',

        -- Business sub-types.
        'markets', 'banking', 'crypto', 'realestate', 'labor',

        -- Crime / safety sub-types.
        'shooting', 'terrorism', 'cybercrime', 'missing', 'traffic',

        -- Weather sub-types.
        'storm', 'floods', 'wildfire', 'drought', 'snow', 'heatwave',

        -- Science sub-types.
        'space', 'biology', 'physics', 'research',

        -- Technology sub-types.
        'ai', 'cybersecurity', 'gaming', 'telecom',

        -- Sports sub-types.
        'soccer', 'basketball', 'olympics', 'racing',

        -- Culture sub-types.
        'music', 'film', 'art', 'books',

        -- Environment sub-types.
        'climate', 'wildlife', 'pollution', 'energy',

        -- Health sub-types.
        'outbreak', 'medical', 'mental_health',

        -- Conflict / disaster.
        'war', 'military', 'earthquake', 'volcano', 'refugees', 'aid',

        -- Local & Global Interest sub-types.
        'education', 'food', 'transit', 'festivals', 'religion', 'housing', 'automotive', 'trade'
    )
);

-- Same widening for the precision sub-enum if anyone stored a category-shaped
-- value in a wrong column (none today, but defensive).
DO $$ BEGIN
    PERFORM 1 FROM pg_constraint WHERE conname = 'pins_category_check';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
