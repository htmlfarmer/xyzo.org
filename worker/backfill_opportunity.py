"""Backfill script to fix misclassified "Opportunity, US" pins.

Identifies articles and pins geocoded to "Opportunity" (Montana or Maryland)
that do not explicitly reference Montana (MT) or Maryland (MD), resetting their
location status so they can be re-evaluated or left as unlocated.
"""
import logging
import sys
from worker.db import connect

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("xyzo.backfill_opportunity")

def run_backfill(apply: bool = False):
    with connect() as conn, conn.cursor() as cur:
        # Check news_articles
        cur.execute("""
            SELECT id, title, body, location_text, extracted_location, auto_categorize_city_label
            FROM news_articles
            WHERE location_text ILIKE '%Opportunity%'
               OR extracted_location ILIKE '%Opportunity%'
               OR auto_categorize_city_label ILIKE '%Opportunity%'
        """)
        articles = cur.fetchall()
        log.info("Found %d articles matching Opportunity", len(articles))

        to_reset = []
        for art in articles:
            text = f"{art.get('title') or ''} {(art.get('body') or '')[:2000]}".lower()
            has_mt = "montana" in text or " mt " in text or ", mt" in text or "opportunity, mt" in text
            has_md = "maryland" in text or " md " in text or ", md" in text or "opportunity, md" in text
            if not (has_mt or has_md):
                to_reset.append(art["id"])

        log.info("%d articles identified as false-positive Opportunity pins", len(to_reset))

        if apply and to_reset:
            cur.execute("""
                UPDATE news_articles
                SET status = 'pending',
                    location_text = NULL,
                    extracted_location = NULL,
                    extracted_lat = NULL,
                    extracted_lng = NULL,
                    location_id = NULL,
                    geocoded_at = NULL,
                    auto_categorize_status = 'needs_review',
                    auto_categorize_city_label = NULL
                WHERE id = ANY(%s)
            """, (to_reset,))
            log.info("Reset %d false-positive Opportunity articles in news_articles", len(to_reset))

        # Check news_locations
        cur.execute("SELECT id, place_name FROM news_locations WHERE place_name ILIKE '%Opportunity%'")
        locations = cur.fetchall()
        log.info("Found %d news_locations matching Opportunity", len(locations))

if __name__ == "__main__":
    apply_changes = "--fix" in sys.argv or "--apply" in sys.argv
    run_backfill(apply=apply_changes)
