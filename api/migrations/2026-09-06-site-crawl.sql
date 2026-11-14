-- ── 2026-09-06-site-crawl.sql ────────────────────────────────────────
--
-- Adds the site-crawl subsystem tables:
--   site_crawl_results    — one row per crawl run
--   discovered_pages      — per-page findings (URL, status, kind, signals)
--   crawl_events          — extracted events with cross-source dedup
--
-- The crawler walks a domain BFS-first, prioritises event-shaped
-- paths, and extracts events from JSON-LD / RSS / HTML heuristics /
-- Claude (when XYZO_CLAUDE_API_KEY is set). All idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS site_crawl_results (
    id              BIGSERIAL PRIMARY KEY,
    seed_url        TEXT NOT NULL,
    host            TEXT NOT NULL,
    politeness_tier TEXT NOT NULL DEFAULT 'commercial',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    max_pages       INTEGER NOT NULL DEFAULT 50,
    max_depth       INTEGER NOT NULL DEFAULT 3,
    pages_crawled   INTEGER NOT NULL DEFAULT 0,
    events_found    INTEGER NOT NULL DEFAULT 0,
    feeds_found     INTEGER NOT NULL DEFAULT 0,
    sitemaps_found  INTEGER NOT NULL DEFAULT 0,
    robots_verdict  TEXT,            -- 'allowed' | 'partial' | 'blocked'
    robots_note     TEXT,
    error           TEXT,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS site_crawl_host_idx
    ON site_crawl_results (host, started_at DESC);

CREATE INDEX IF NOT EXISTS site_crawl_started_idx
    ON site_crawl_results (started_at DESC)
    WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS discovered_pages (
    id              BIGSERIAL PRIMARY KEY,
    crawl_id        BIGINT REFERENCES site_crawl_results(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    final_url       TEXT,
    parent_url      TEXT,
    depth           INTEGER NOT NULL DEFAULT 0,
    priority        REAL NOT NULL DEFAULT 0.5,   -- 0..1
    status          INTEGER,
    content_type    TEXT,
    title           TEXT,
    html_lang       TEXT,
    bytes           INTEGER,
    rss_links       JSONB NOT NULL DEFAULT '[]'::jsonb,
    json_ld_events  JSONB NOT NULL DEFAULT '[]'::jsonb,
    heuristic_events JSONB NOT NULL DEFAULT '[]'::jsonb,
    og_tags         JSONB NOT NULL DEFAULT '{}'::jsonb,
    out_links_count INTEGER NOT NULL DEFAULT 0,
    signals         TEXT[] NOT NULL DEFAULT '{}', -- 'rss', 'json_ld_event', 'agenda', 'has_dates', etc.
    crawled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    error           TEXT
);

CREATE INDEX IF NOT EXISTS discovered_pages_crawl_idx
    ON discovered_pages (crawl_id, depth, priority DESC);

CREATE INDEX IF NOT EXISTS discovered_pages_url_idx
    ON discovered_pages (url);

CREATE INDEX IF NOT EXISTS discovered_pages_signals_idx
    ON discovered_pages USING gin (signals);

CREATE TABLE IF NOT EXISTS crawl_events (
    id              BIGSERIAL PRIMARY KEY,
    crawl_id        BIGINT REFERENCES site_crawl_results(id) ON DELETE CASCADE,
    page_id         BIGINT REFERENCES discovered_pages(id) ON DELETE CASCADE,
    source_url      TEXT NOT NULL,
    title           TEXT,
    description     TEXT,
    starts_at       TIMESTAMPTZ,
    ends_at         TIMESTAMPTZ,
    venue_name      TEXT,
    city            TEXT,
    country_code    TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    image_url       TEXT,
    price_min       NUMERIC(10,2),
    price_max       NUMERIC(10,2),
    currency        TEXT,
    is_free         BOOLEAN,
    is_online       BOOLEAN NOT NULL DEFAULT FALSE,
    event_url       TEXT,
    organizer_name  TEXT,
    extraction      TEXT NOT NULL,  -- 'json_ld' | 'rss' | 'heuristic' | 'ai'
    confidence      REAL NOT NULL DEFAULT 0.5,
    content_hash    TEXT,
    raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crawl_events_crawl_idx
    ON crawl_events (crawl_id, starts_at);

CREATE INDEX IF NOT EXISTS crawl_events_hash_idx
    ON crawl_events (content_hash)
    WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS crawl_events_extraction_idx
    ON crawl_events (extraction, confidence DESC);

COMMIT;
