"""Audio geocoder — turns audio_episodes.location_text into lat/lng.

Reuses the existing geocode.geocode_one() and geocode.upsert_location()
functions. Finds episodes with location_text but no extracted_lat,
geocodes them, and writes back the coordinates + location_id.

This is what makes episodes appear on the map.
"""
import logging
import time

import httpx

from .db import connect
from .geocode import geocode_one, upsert_location, MIN_INTERVAL_S, NOMINATIM_URL, USER_AGENT, TIMEOUT_S, _HTTPX_LIMITS

log = logging.getLogger("xyzo.audio_geocode")


def _fetch_episodes_needing_geocode(limit: int = 300) -> list[dict]:
    """Find audio episodes with location_text but no coordinates."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT e.id, e.location_text
            FROM audio_episodes e
            WHERE e.location_text IS NOT NULL
              AND e.location_text != ''
              AND e.extracted_lat IS NULL
              AND e.status != 'failed'
            ORDER BY e.published_at DESC NULLS LAST
            LIMIT %s
        """, (limit,))
        return list(cur.fetchall())


def geocode_audio_episodes(limit: int = 300) -> dict:
    """Geocode audio episodes that have location_text but no coordinates.

    Returns summary dict with geocoded/failed/skipped counts.
    """
    summary = {"geocoded": 0, "failed": 0, "skipped": 0}
    episodes = _fetch_episodes_needing_geocode(limit)

    if not episodes:
        log.info("audio_geocode: no episodes need geocoding")
        return summary

    log.info("audio_geocode: %d episodes to geocode", len(episodes))

    last_nominatim_call = 0.0

    with httpx.Client(timeout=TIMEOUT_S, limits=_HTTPX_LIMITS) as client:
        for ep in episodes:
            ep_id = ep["id"]
            location_text = ep["location_text"]

            # Rate limit: 1 req/sec for public Nominatim
            elapsed = time.time() - last_nominatim_call
            if elapsed < MIN_INTERVAL_S:
                time.sleep(MIN_INTERVAL_S - elapsed)

            try:
                loc = geocode_one(client, location_text)
                last_nominatim_call = time.time()

                if not loc:
                    summary["failed"] += 1
                    log.debug("audio_geocode: no result for %r (episode %d)", location_text, ep_id)
                    continue

                # Upsert into news_locations (shared with articles)
                location_id = upsert_location(loc)

                # Update the audio episode with coordinates + location_id
                with connect() as conn, conn.cursor() as cur:
                    cur.execute("""
                        UPDATE audio_episodes SET
                            extracted_lat = %s,
                            extracted_lng = %s,
                            extracted_location = %s,
                            location_id = %s,
                            location_confidence = %s,
                            geocoded_at = now()
                        WHERE id = %s
                    """, (
                        loc["lat"], loc["lng"], loc["place_name"],
                        location_id, loc["confidence"], ep_id,
                    ))
                    conn.commit()

                summary["geocoded"] += 1
                log.debug("audio_geocode: %s → %.4f, %.4f (episode %d)",
                         location_text, loc["lat"], loc["lng"], ep_id)

            except Exception as exc:
                summary["failed"] += 1
                log.warning("audio_geocode: error for episode %d (%r): %s", ep_id, location_text, exc)

    return summary


def run(limit: int = 300) -> dict:
    """Main entry point for audio geocoding."""
    return geocode_audio_episodes(limit)
