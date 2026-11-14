#!/usr/bin/env python3
"""Repair rural-anchored news sources and their fallback-placed articles.

Root cause this heals (2026-08-28): _geocode_source_location fed free
text like "europe, DE" to Nominatim; it answered with "Sender Europe 1"
— a mediumwave transmitter in rural Saarland — and five German national
papers (ZEIT, FAZ, Stern, t-online, Morgenpost) got anchored there.
~250 articles whose text contains no city then fell back to the source
anchor and were "spread" across farmland around 49.28, 6.66.

The pipeline code is fixed (deterministic capital map + admin-type
validation + snap-to-city spread + rural-anchor rejection in
auto_categorize). This script repairs the DATA:

  1. Every news_sources row whose coordinates are >25 km from ANY
     town (population >= 25k) is "broken". Re-anchor it via the
     deterministic geocode_sources mapping (country → capital, region
     → region center); if that yields nothing, NULL the coordinates so
     auto_categorize ignores the source.
  2. Articles that were placed via a source anchor (status
     'source_based' / 'density_flagged' / hash_spread) and now sit in
     the countryside get their pipeline fields reset to 'pending' so
     the next fetch cycle re-locates them from their own text
     (fast-path city scan → wiki_geo → AI extract), landing on real
     cities.

Usage:
    python3 -m scripts.repair_rural_anchors --dry-run
    python3 -m scripts.repair_rural_anchors
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.db import connect
from worker.density import _snap_to_major_city
from worker.geocode_sources import geocode_source

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_rural_anchors")

TOWN_MIN_POP = 25_000
RURAL_RADIUS_KM = 25.0

# auto_categorize_status values that mean "this article has no
# location of its own; it sits where its source sits". Only these are
# safe to reset — AI-extracted articles keep their real locations.
FALLBACK_STATUSES = ("source_based", "density_flagged")


def find_broken_sources() -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, country, region, lat, lng, geocoded_location "
            "FROM news_sources WHERE lat IS NOT NULL AND lng IS NOT NULL"
        )
        rows = cur.fetchall()
    broken = []
    for s in rows:
        near = _snap_to_major_city(float(s["lat"]), float(s["lng"]), min_pop=TOWN_MIN_POP)
        dist = (near or {}).get("dist_km")
        if near is None or dist is None or dist > RURAL_RADIUS_KM:
            s["_near"] = near
            broken.append(s)
    return broken


def repair_sources(sources: list[dict], dry: bool) -> dict[int, str]:
    """Re-anchor broken sources deterministically. Returns id → action."""
    actions: dict[int, str] = {}
    with connect() as conn, conn.cursor() as cur:
        for s in sources:
            result = geocode_source(s["name"], s["country"], s["region"])
            near = s.get("_near") or {}
            label = f"{near.get('name', '?')} {round(near.get('dist_km') or 0)}km"
            if result:
                if not dry:
                    cur.execute(
                        """
                        UPDATE news_sources
                        SET lat = %s, lng = %s, geocoded_location = %s,
                            geocoded_at = now(),
                            geom = ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                        WHERE id = %s
                        """,
                        (result["lat"], result["lng"], result["geocoded_location"],
                         result["lng"], result["lat"], s["id"]),
                    )
                actions[s["id"]] = f"re-anchored → {result['geocoded_location']} (was rural: {label})"
            else:
                if not dry:
                    cur.execute(
                        "UPDATE news_sources SET lat = NULL, lng = NULL, geocoded_location = NULL WHERE id = %s",
                        (s["id"],),
                    )
                actions[s["id"]] = f"coords NULLed (no deterministic anchor; was rural: {label})"
    return actions


def requeue_rural_fallback_articles(source_ids: list[int], dry: bool) -> int:
    """Reset fallback-placed articles of repaired sources to pending."""
    if not source_ids:
        return 0
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.id, a.extracted_lat, a.extracted_lng
            FROM news_articles a
            WHERE a.source_id = ANY(%s)
              AND a.auto_categorize_status = ANY(%s)
              AND a.extracted_lat IS NOT NULL
              AND a.status IN ('extracted', 'clustered', 'pending')
            """,
            (source_ids, list(FALLBACK_STATUSES)),
        )
        rows = cur.fetchall()

    rural_ids: list[int] = []
    for r in rows:
        near = _snap_to_major_city(float(r["extracted_lat"]), float(r["extracted_lng"]), min_pop=TOWN_MIN_POP)
        dist = (near or {}).get("dist_km")
        if near is None or dist is None or dist > RURAL_RADIUS_KM:
            rural_ids.append(r["id"])

    if rural_ids and not dry:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                UPDATE news_articles
                SET status = 'pending',
                    location_id = NULL,
                    location_text = NULL,
                    extracted_location = NULL,
                    extracted_lat = NULL,
                    extracted_lng = NULL,
                    extracted_at = NULL,
                    geocoded_at = NULL,
                    location_confidence = NULL,
                    auto_categorized_at = NULL,
                    auto_categorize_status = NULL,
                    auto_categorize_confidence = NULL,
                    auto_categorize_city_id = NULL,
                    auto_categorize_city_label = NULL,
                    auto_categorize_method = NULL,
                    error_message = NULL
                WHERE id = ANY(%s)
                """,
                (rural_ids,),
            )
    return len(rural_ids)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit-sources", type=int, default=0, help="debug: cap source repairs")
    args = ap.parse_args()

    broken = find_broken_sources()
    log.info("broken (rural-anchored) sources: %d", len(broken))
    for s in broken[:40]:
        near = s.get("_near") or {}
        log.info("  #%s %s — at %.3f,%.3f (%s, nearest town %s %.0fkm)",
                 s["id"], s["name"], s["lat"], s["lng"],
                 (s.get("geocoded_location") or "")[:50],
                 near.get("name", "?"), near.get("dist_km") or 0)
    if args.limit_sources:
        broken = broken[: args.limit_sources]

    actions = repair_sources(broken, args.dry_run)
    for sid, act in actions.items():
        log.info("  source %s: %s", sid, act)

    n_requeued = requeue_rural_fallback_articles(list(actions.keys()), args.dry_run)
    log.info("fallback articles reset to pending for re-location: %d%s",
             n_requeued, " (dry-run, not applied)" if args.dry_run else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
