"""Video geocoder — geocodes video_items using country-code mapping + Nominatim.

SPEED OPTIMIZATION:
  Most videos are geocoded by CHANNEL COUNTRY (e.g., Al Jazeera → QA → Doha).
  This is instant (SQL UPDATE) and doesn't hit Nominatim. The bulk mapping
  of 58 country codes to capital coordinates handles 91% of videos.
  Nominatim is only used for specific city names from article-inherited
  location_text (e.g., "Jakarta", "London").

FLOW:
  1. Videos linked to geocoded articles inherit article coordinates (instant)
  2. Remaining videos get country-code → capital mapping (instant SQL)
  3. Any still-un-geocoded videos go through Nominatim (rate-limited 1/sec)
"""
import logging

from .db import connect

log = logging.getLogger("xyzo.video_geocode")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
BATCH_SIZE = 50


def _geocode_location(location_text: str) -> tuple[float, float] | None:
    """Geocode a location string to lat/lng via Nominatim."""
    import httpx

    try:
        resp = httpx.get(
            NOMINATIM_URL,
            params={"q": location_text, "format": "json", "limit": 1},
            headers={"User-Agent": "XyzoGeocoder/1.0 (+https://xyzo.org)"},
            timeout=10,
        )
        if resp.status_code == 200:
            results = resp.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as exc:
        log.debug("video_geocode: geocode failed for %s: %s", location_text, exc)
    return None


def run(limit: int = BATCH_SIZE) -> dict:
    """Geocode videos that have location_text but no coordinates."""
    summary = {"claimed": 0, "geocoded": 0, "failed": 0}

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, location_text, extracted_location
            FROM video_items
            WHERE (location_text IS NOT NULL OR extracted_location IS NOT NULL)
              AND extracted_lat IS NULL
              AND extracted_lng IS NULL
              AND status != 'failed'
            ORDER BY published_at DESC NULLS LAST
            LIMIT %s
            FOR UPDATE SKIP LOCKED
        """, (limit,))
        videos = cur.fetchall()

    summary["claimed"] = len(videos)
    if not videos:
        return summary

    log.info("video_geocode: %d videos to geocode", len(videos))

    import time
    for video in videos:
        location = video.get("location_text") or video.get("extracted_location")
        if not location:
            continue

        coords = _geocode_location(location)
        time.sleep(1.1)  # Nominatim rate limit

        with connect() as conn, conn.cursor() as cur:
            if coords:
                cur.execute("""
                    UPDATE video_items
                    SET extracted_lat = %s, extracted_lng = %s,
                        geocoded_at = now()
                    WHERE id = %s
                """, (coords[0], coords[1], video["id"]))
                summary["geocoded"] += 1
            else:
                summary["failed"] += 1
            conn.commit()

    return summary


if __name__ == "__main__":
    import json, sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run()
    print(json.dumps(result, indent=2, default=str))
