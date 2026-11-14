"""DB migration: add robots.txt tracking columns to news_sources.

Adds:
  - robots_checked_at      TIMESTAMPTZ   — when robots.txt was last verified
  - robots_status           TEXT           — 'allowed' | 'blocked' | 'unreachable' | 'error'
  - robots_content_hash     TEXT           — SHA256 of robots.txt body (detect changes)
  - robots_http_status     INTEGER        — HTTP status code of robots.txt fetch
  - robots_sitemaps        JSONB          — array of Sitemap: URLs found

Safe to re-run — uses DO $$ IF NOT EXISTS block.

Run:
    python3 worker/migrate_robots_verify.py
"""
from __future__ import annotations

import logging
import os
import sys

import psycopg

log = logging.getLogger("xyzo.migrate_robots")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo",
)


def migrate() -> None:
    SQL = """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'news_sources'
              AND column_name = 'robots_checked_at'
        ) THEN
            ALTER TABLE news_sources ADD COLUMN robots_checked_at TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'news_sources'
              AND column_name = 'robots_status'
        ) THEN
            ALTER TABLE news_sources ADD COLUMN robots_status TEXT
                DEFAULT 'pending'
                CHECK (robots_status IN ('pending', 'allowed', 'blocked', 'unreachable', 'error'));
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'news_sources'
              AND column_name = 'robots_content_hash'
        ) THEN
            ALTER TABLE news_sources ADD COLUMN robots_content_hash TEXT;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'news_sources'
              AND column_name = 'robots_http_status'
        ) THEN
            ALTER TABLE news_sources ADD COLUMN robots_http_status INTEGER;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'news_sources'
              AND column_name = 'robots_sitemaps'
        ) THEN
            ALTER TABLE news_sources ADD COLUMN robots_sitemaps JSONB DEFAULT '[]'::jsonb;
        END IF;
    END
    $$;
    """
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(SQL)
        conn.commit()
    log.info("Migration complete: robots tracking columns added to news_sources")


if __name__ == "__main__":
    migrate()
