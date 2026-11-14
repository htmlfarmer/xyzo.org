-- 2026-09-28: user interactivity — news submission queue + article recommendations.
--
-- POST /api/news/submit      → user_news_submissions (status='pending'; a queue
--                               for review — NEVER auto-inserts into news_articles
--                               and never triggers a synchronous scrape).
-- POST /api/news/:id/recommend → news_article_recommendations (one vote per IP)
--                               + denormalized news_articles.recommend_count
--                               maintained with integer increment UPDATEs.
--
-- BigInt rule (README): every aggregate read of these counters uses ::float.

CREATE TABLE IF NOT EXISTS user_news_submissions (
  id           BIGSERIAL PRIMARY KEY,
  url          TEXT NOT NULL,
  title        TEXT,
  note         TEXT,
  submitter_ip INET,
  session_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate')),
  source_id    INT,               -- set when approved and a news_sources row exists
  reviewed_at  TIMESTAMPTZ,
  reviewed_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One pending row per URL (md5 keeps the index small for 2 KB URLs).
CREATE UNIQUE INDEX IF NOT EXISTS user_news_submissions_pending_url_idx
  ON user_news_submissions (md5(url)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS user_news_submissions_status_idx
  ON user_news_submissions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS news_article_recommendations (
  id         BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL,
  voter_ip   INET,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IP-based dedup (one recommendation per IP per article). NULL-IP votes
-- (unknown proxy chains) are allowed but rate-limited at the API layer.
CREATE UNIQUE INDEX IF NOT EXISTS news_article_recs_dedup
  ON news_article_recommendations (article_id, voter_ip)
  WHERE voter_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_article_recs_article_idx
  ON news_article_recommendations (article_id);

-- Denormalized counter so feed/pins queries never need an aggregate join.
-- INT default 0 — ADD COLUMN with a constant default is metadata-only on PG 11+.
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS recommend_count INT NOT NULL DEFAULT 0;

GRANT SELECT, INSERT, UPDATE ON user_news_submissions TO xyzo_app;
GRANT USAGE, SELECT ON SEQUENCE user_news_submissions_id_seq TO xyzo_app;
GRANT SELECT, INSERT ON news_article_recommendations TO xyzo_app;
GRANT USAGE, SELECT ON SEQUENCE news_article_recommendations_id_seq TO xyzo_app;
