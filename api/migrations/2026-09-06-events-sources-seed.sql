-- ── 2026-09-06-events-sources-seed.sql ──────────────────────────────
--
-- Seeds event_sources from the user's priority list (2026-09-06),
-- plus the RSS endpoints I confirmed are returning 200 from probes.
--
-- Most of the "gold" tier sources (Eventbrite, Meetup, Lu.ma) require
-- API keys we don't have. For those we record the source as 'inactive'
-- with notes explaining the blocker, so the row exists and the worker
-- knows to enable it the moment a token shows up.
--
-- Idempotent via ON CONFLICT (source, host) DO NOTHING.

BEGIN;

-- ── Tier 1-5: gated by paid/API keys (kept inactive for now) ──────
INSERT INTO event_sources
    (source, name, host, feed_url, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('eventbrite', 'Eventbrite (Global)', 'eventbrite.com',
     'https://www.eventbriteapi.com/v3/events/search/',
     'https://www.eventbrite.com',
     'community', 1, 'platform', FALSE,
     'Gated by XYZO_EVENTBRITE_TOKEN. Discovery API token required.'),
    ('meetup', 'Meetup (Global)', 'meetup.com',
     'https://api.meetup.com/gql',
     'https://www.meetup.com',
     'meetup', 2, 'platform', FALSE,
     'Gated by XYZO_MEETUP_TOKEN. GraphQL endpoint, OAuth required.'),
    ('luma', 'Lu.ma (Tech/Startup)', 'lu.ma',
     'https://api.lu.ma/discover/get-events',
     'https://lu.ma',
     'meetup', 3, 'platform', FALSE,
     'Gated by XYZO_LUMA_TOKEN. Discovery API.'),
    ('allevents', 'AllEvents.in (Global)', 'allevents.in',
     NULL,
     'https://allevents.in',
     'community', 4, 'community', FALSE,
     'No public RSS — requires HTML scraping. Inactive until scraper ready.'),
    ('10times', '10times (Conferences)', '10times.com',
     NULL,
     'https://10times.com',
     'conference', 5, 'commercial', FALSE,
     'No public RSS — directory only.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 6-8: conferences/academic — gated or scraper-only ──────
INSERT INTO event_sources
    (source, name, host, feed_url, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('rss', 'Conference Alerts', 'conferencealerts.com',
     NULL, 'https://www.conferencealerts.com',
     'conference', 6, 'commercial', FALSE,
     'No RSS endpoint found in probing — directory only.'),
    ('rss', 'ConfRoll', 'confroll.co',
     NULL, 'https://confroll.co',
     'conference', 7, 'commercial', FALSE,
     'No public RSS — aggregator without feed.'),
    ('wikicfp', 'WikiCFP', 'wikicfp.com',
     NULL, 'https://wikicfp.com',
     'conference', 8, 'community', FALSE,
     'Atom feed exists at /cfp/rss but returns 403 to non-browser UAs.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 9-13: concerts/music — partially working ────────────────
INSERT INTO event_sources
    (source, name, host, feed_url, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('rss', 'Resident Advisor', 'ra.co',
     'https://ra.co/xml/rss.xml', 'https://www.residentadvisor.net',
     'concert', 9, 'commercial', TRUE,
     'Recently confirmed RSS working as of 2026-09-06.'),
    ('songkick', 'Songkick', 'songkick.com',
     'https://www.songkick.com/developer', 'https://www.songkick.com',
     'concert', 10, 'platform', FALSE,
     'Gated by XYZO_SONGKICK_API_KEY.'),
    ('bandsintown', 'Bandsintown', 'bandsintown.com',
     NULL, 'https://www.bandsintown.com',
     'concert', 11, 'platform', FALSE,
     'No public RSS — requires partnership / API key.'),
    ('rss', 'JamBase', 'jambase.com',
     'https://www.jambase.com/feed', 'https://www.jambase.com',
     'concert', 12, 'commercial', TRUE,
     'RSS confirmed working.'),
    ('rss', 'Festivalnet', 'festivalnet.com',
     'https://www.festivalnet.com/rss', 'https://www.festivalnet.com',
     'festival', 13, 'community', TRUE,
     'RSS confirmed working.')
ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 14: Music Festival Wizard ────────────────────────────────
INSERT INTO event_sources
    (source, name, host, feed_url, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('rss', 'Music Festival Wizard', 'musicfestivalwizard.com',
     'https://www.musicfestivalwizard.com/feed/',
     'https://www.musicfestivalwizard.com',
     'festival', 14, 'commercial', FALSE,
     'Feed path exists but returns 403 to generic UA; retry with a real UA header.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 15: University calendars ────────────────────────────────
-- These need Localist / Trumba / 25Live scrapers — most return 403.
-- Seeded as inactive, with notes about the platform each one runs on.
INSERT INTO event_sources
    (source, name, host, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('ical', 'Harvard Events', 'events.harvard.edu',
     'https://events.harvard.edu', 'lecture', 15, 'university', FALSE,
     'Localist. Returns 403 to scrapers; needs browser-fetch via Playwright.'),
    ('ical', 'Stanford Events', 'events.stanford.edu',
     'https://events.stanford.edu', 'lecture', 15, 'university', FALSE,
     'Localist. Same blocker as Harvard.'),
    ('ical', 'MIT Events', 'events.mit.edu',
     'https://events.mit.edu', 'lecture', 15, 'university', FALSE,
     '25Live / Trumba. Requires browser-fetch.'),
    ('ical', 'Berkeley Events', 'events.berkeley.edu',
     'https://events.berkeley.edu', 'lecture', 15, 'university', FALSE,
     'Localist.'),
    ('ical', 'Princeton Events', 'events.princeton.edu',
     'https://events.princeton.edu', 'lecture', 15, 'university', FALSE,
     'Localist.'),
    ('ical', 'Yale Events', 'events.yale.edu',
     'https://events.yale.edu', 'lecture', 15, 'university', FALSE,
     'Localist.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 16: City calendars (politeness: GOV tier) ───────────────
-- Per the user's constraint (2026-09-06): robots.txt MANDATORY,
-- 24h minimum interval, single retry on 5xx.
INSERT INTO event_sources
    (source, name, host, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('ical', 'NYC.gov Events', 'nyc.gov',
     'https://www.nyc.gov/events', 'community', 16, 'gov', FALSE,
     'No public feed — search HTML or subscribe to borough RSS.'),
    ('ical', 'Chicago Events', 'chicago.gov',
     'https://www.chicago.gov/city/en/depts/special_events.html',
     'community', 16, 'gov', FALSE, 'No public feed.'),
    ('ical', 'SF Events', 'sf.gov',
     'https://sf.gov/events', 'community', 16, 'gov', FALSE,
     'HTML-only listing.'),
    ('ical', 'Seattle Events', 'seattle.gov',
     'https://www.seattle.gov/event-calendar', 'community', 16, 'gov', FALSE,
     'No public feed.'),
    ('ical', 'LA Events', 'lacity.gov',
     'https://www.lacity.org/events', 'community', 16, 'gov', FALSE,
     'No public feed.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 17: Museum calendars ────────────────────────────────────
INSERT INTO event_sources
    (source, name, host, feed_url, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('rss', 'SFMOMA Events', 'sfmoma.org',
     'https://www.sfmoma.org/events/feed/',
     'https://www.sfmoma.org',
     'community', 17, 'community', TRUE, 'RSS confirmed working.'),
    ('rss', 'Met Museum Events', 'metmuseum.org',
     NULL, 'https://www.metmuseum.org/events',
     'community', 17, 'community', FALSE,
     'RSS path returns 403; check /events/talks.rss.'),
    ('rss', 'MoMA Events', 'moma.org',
     'https://www.moma.org/calendar/feeds/events.rss',
     'https://www.moma.org/calendar',
     'community', 17, 'community', TRUE, 'Feed path known but unverified.'),
    ('rss', 'Smithsonian Events', 'si.edu',
     NULL, 'https://www.si.edu/events',
     'community', 17, 'community', FALSE, 'No public feed.'),
    ('rss', 'Tate Events', 'tate.org.uk',
     NULL, 'https://www.tate.org.uk/whats-on',
     'community', 17, 'community', FALSE, 'No public feed.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 18: Convention centers ──────────────────────────────────
INSERT INTO event_sources
    (source, name, host, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('ical', 'Javits Center (NYC)', 'javitscenter.com',
     'https://www.javitscenter.com', 'conference', 18, 'commercial', FALSE,
     'No public feed.'),
    ('ical', 'McCormick Place (Chicago)', 'mccormickplace.com',
     'https://www.mccormickplace.com', 'conference', 18, 'commercial', FALSE,
     'No public feed.'),
    ('ical', 'Las Vegas Convention Center', 'lvcc.com',
     'https://www.lvcva.com', 'conference', 18, 'commercial', FALSE,
     'No public feed.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 19: Sports calendars ────────────────────────────────────
INSERT INTO event_sources
    (source, name, host, feed_url, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('rss', 'ESPN Events', 'espn.com',
     'https://www.espn.com/espn/rss/news', 'https://www.espn.com/events',
     'sports', 19, 'commercial', FALSE, 'Generic news feed only.'),
    ('rss', 'Olympics', 'olympics.com',
     NULL, 'https://www.olympics.com/en/news',
     'sports', 19, 'commercial', FALSE, 'No public feed.'),
    ('rss', 'FIFA', 'fifa.com',
     NULL, 'https://www.fifa.com/fixtures',
     'sports', 19, 'commercial', FALSE, 'No public feed.'),
    ('rss', 'NBA', 'nba.com',
     NULL, 'https://www.nba.com/schedule',
     'sports', 19, 'commercial', FALSE, 'No public feed.'),
    ('rss', 'NFL', 'nfl.com',
     NULL, 'https://www.nfl.com/schedules',
     'sports', 19, 'commercial', FALSE, 'No public feed.'),
    ('rss', 'MLB', 'mlb.com',
     NULL, 'https://www.mlb.com/schedule',
     'sports', 19, 'commercial', FALSE, 'No public feed.'),
    ('rss', 'NHL', 'nhl.com',
     NULL, 'https://www.nhl.com/schedule',
     'sports', 19, 'commercial', FALSE, 'No public feed.'),
    ('rss', 'parkrun', 'parkrun.com',
     NULL, 'https://www.parkrun.com/events',
     'sports', 19, 'community', FALSE,
     'Events are JSON-driven from a single endpoint; needs API key.'),
    ('rss', 'RunSignUp', 'runsignup.com',
     NULL, 'https://runsignup.com/RaceCalendar',
     'sports', 19, 'commercial', FALSE,
     'Calendar widget only; HTML scrape needed.'),
    ('rss', 'Active.com', 'active.com',
     NULL, 'https://www.active.com/events',
     'sports', 19, 'commercial', FALSE, 'No public feed.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Tier 20: Local venues — long tail, populated by discovery loop
-- These are sample rows; the real source list comes from the URL-
-- pattern discovery worker that walks `event_url_patterns` against
-- newly-discovered hosts.
INSERT INTO event_sources
    (source, name, host, website_url, default_category,
     source_priority, politeness_tier, is_active, notes)
VALUES
    ('local-venue', 'Local venue (discovery pending)', 'pending.local',
     NULL, 'concert', 20, 'commercial', FALSE,
     'Placeholder for auto-discovered local venues. Discovery loop not yet enabled.')

ON CONFLICT (source, host) DO NOTHING;

-- ── Summary ──────────────────────────────────────────────────────
DO $$
DECLARE
    n_active INT;
    n_total  INT;
BEGIN
    SELECT count(*) INTO n_total FROM event_sources;
    SELECT count(*) INTO n_active FROM event_sources WHERE is_active = TRUE;
    RAISE NOTICE 'event_sources seeded: % total, % active', n_total, n_active;
END$$;

COMMIT;
