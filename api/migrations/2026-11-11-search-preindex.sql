-- THE SEARCH PRE-INDEX: the answers to the most-searched queries,
-- computed in the background so a common search is instant.
--
-- WHY THIS EXISTS. Measured 2026-11-11 on the live site, a text search
-- took 24–75 s cold (before the index fixes of the same day) and
-- 0.5–2 s after them. That is a big improvement, but it is still a
-- DATABASE QUERY PER READER, and the corpus grows: every minute of
-- news makes the trigram scan wider. The pre-index answers the popular
-- queries from a stored answer instead, and a background job keeps the
-- stored answer current — the reader gets the answer in ~100 ms while
-- the live query runs behind it.
--
-- WHAT IS STORED IS THE ANSWER, NOT THE STORIES. The payload is the
-- pin list as the API serves it (slimmed: no word_freq, which the
-- popup fetches on demand from /api/pins/:id/words — the same slimming
-- the browser-side saved-searches store already does). The ARTICLES
-- themselves are never copied: a stored answer points at live rows, so
-- a title, an image and a timestamp are always current; only the
-- SELECTION is precomputed, and the background job recomputes it.
--
-- THE KEY CARRIES THE TIME WINDOW, NOT THE TIMESTAMP. The frontend asks
-- for "24h" as `since=<now - 24h, snapped to the minute>`, so a key
-- built from the timestamp would never be found again — the trap the
-- browser-side store already documents. The window is derived from the
-- age of `since` (see windowKeyFor() in api/src/lib/preindex.ts), and
-- the key is `query | window | tag`.
--
-- `built_at` is what the reader is told: a pre-indexed answer is
-- always served with its age, never as if it were live.
--
-- Applied 2026-11-11. Run:
--   psql "$XYZO_DB_DSN" -f api/migrations/2026-11-11-search-preindex.sql

CREATE TABLE IF NOT EXISTS search_preindex (
    id          bigserial PRIMARY KEY,
    query_key   text        NOT NULL,          -- normalised query (see queryKeyFor)
    query       text        NOT NULL,          -- the query as it was asked
    time_window text        NOT NULL DEFAULT 'all',   -- 'window' is a reserved word
    tag         text        NOT NULL DEFAULT '',
    limit_n     integer     NOT NULL DEFAULT 1000,
    payload     jsonb       NOT NULL,          -- { pins: [...], next_cursor, has_more }
    pin_count   integer     NOT NULL DEFAULT 0,
    built_at    timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    UNIQUE (query_key, time_window, tag, limit_n)
);

-- The builder asks for "the stalest entries first" to spread the work.
CREATE INDEX IF NOT EXISTS search_preindex_stale_idx
    ON search_preindex (built_at);

-- The same table records WHICH queries are worth precomputing: the
-- search path upserts every query it answers, so the list is the real
-- demand rather than a guess. It was designed for this and had ONE ROW in
-- it (only /api/searches/save wrote to it).
--
-- The table and its index (search_query_stats_top_idx) already exist in
-- production, so they are not recreated here — this migration only
-- changes WHO WRITES to it.
