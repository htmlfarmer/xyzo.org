#!/usr/bin/env python3
"""Expire image_url values on old articles.

By default clears image_url on articles older than 7 days so we stop
hotlinking images from dead/replaced publisher content.

Usage:
    python -m worker.expire_images        # 7-day retention (default)
    python -m worker.expire_images 1     # 1-day retention
    XYMO_IMAGE_RETENTION_DAYS=1 python -m worker.expire_images

Run via cron, e.g. daily at 04:00:
    0 4 * * * cd /var/www/vhosts/xyzo.org && python -m worker.expire_images
"""

import os
import logging

RETENTION_DAYS = int(os.environ.get("XYMO_IMAGE_RETENTION_DAYS", 7))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("expire_images")


def main() -> None:
    import psycopg2, os
    dsn = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")
    conn = psycopg2.connect(dsn)
    with conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM news_articles WHERE image_url IS NOT NULL AND fetched_at < now() - INTERVAL '%s days'",
            (RETENTION_DAYS,),
        )
        to_expire = cur.fetchone()[0]
        if to_expire > 0:
            cur.execute(
                "UPDATE news_articles SET image_url = NULL WHERE image_url IS NOT NULL AND fetched_at < now() - INTERVAL '%s days'",
                (RETENTION_DAYS,),
            )
            log.info("Cleared image_url on %s articles older than %s days", cur.rowcount, RETENTION_DAYS)
        else:
            log.info("No image URLs to expire (%s-day retention)", RETENTION_DAYS)


if __name__ == "__main__":
    main()
