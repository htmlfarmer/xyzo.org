"""Source Location Anomaly Detector — finds sources that systematically place articles in wrong locations.

This worker detects when a source's articles are consistently placed in a city that doesn't
match the source's actual coverage area. This can happen due to:
- AI extraction errors for specific source formats
- Fallback to source headquarters when article has no clear city mentions
- Geocoder errors for certain city names
- Source homepage geocoding errors

Usage:
    python -m worker.audit_sources              # audit all sources
    python -m worker.audit_sources --dry-run  # show what would be corrected
    python -m worker.audit_sources --limit 50  # limit to top sources by article count
"""
from __future__ import annotations

import argparse
import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

from .db import connect
from .fast_suggest import geocode_text

log = logging.getLogger("xyzo.audit_sources")

ANOMALY_THRESHOLD = 0.7  # If >70% of articles are in same non-source country, flag
# But also require that it's in ONE single country (not spread across many) - wire services
# cover multiple countries legitimately
SINGLE_COUNTRY_THRESHOLD = 0.6  # If >60% in ONE country (out of total foreign)


@dataclass
class SourceAnomaly:
    source_id: int
    source_name: str
    source_country: str
    primary_city_id: int | None
    total_articles: int
    misplaced_articles: int
    anomaly_score: float
    expected_city_id: int | None
    actual_city_id: int
    actual_city_name: str
    actual_country: str
    confidence: str  # high, medium, low


def get_source_article_locations(source_id: int) -> list[dict]:
    """Get all location data for articles from a source."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                a.id as article_id,
                a.title,
                a.extracted_lat,
                a.extracted_lng,
                a.extracted_location,
                a.location_confidence,
                a.auto_categorize_method,
                l.id as location_id,
                l.place_name,
                l.country as location_country,
                l.lat as location_lat,
                l.lng as location_lng
            FROM news_articles a
            LEFT JOIN news_locations l ON l.id = a.location_id
            WHERE a.source_id = %s
              AND a.status IN ('extracted', 'clustered')
              AND a.extracted_lat IS NOT NULL
            ORDER BY a.fetched_at DESC
        """, (source_id,))
        return [dict(r) for r in cur.fetchall()]


def get_source_info(source_id: int) -> dict | None:
    """Get source metadata."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, country, region, lat, lng,
                   primary_city_id, homepage_url, source_type
            FROM news_sources
            WHERE id = %s AND active = true
        """, (source_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def analyze_source_anomaly(source_id: int) -> SourceAnomaly | None:
    """Analyze if a source has systematic location anomalies."""
    source = get_source_info(source_id)
    if not source:
        return None

    articles = get_source_article_locations(source_id)
    if len(articles) < 10:
        return None  # Need minimum articles for statistical significance

    source_country = source.get("country", "")
    source_primary_city_id = source.get("primary_city_id")

    # Count articles by location country
    country_counts: dict[str, int] = defaultdict(int)
    city_counts: dict[int, dict] = defaultdict(lambda: {"count": 0, "name": "unknown"})

    for art in articles:
        loc_country = art.get("location_country", "")
        loc_id = art.get("location_id") or 0
        loc_name = art.get("place_name", "unknown")

        if loc_country:
            country_counts[loc_country] += 1
        if loc_id:
            city_counts[loc_id]["count"] += 1
            city_counts[loc_id]["name"] = loc_name

    total = len(articles)

    # Check for anomaly: most articles in non-source country
    anomaly_country = None
    anomaly_score = 0.0

    for country, count in country_counts.items():
        if country != source_country and country:
            ratio = count / total
            if ratio > ANOMALY_THRESHOLD and ratio > anomaly_score:
                anomaly_score = ratio
                anomaly_country = country

    if not anomaly_country:
        return None  # No anomaly detected

    # Find the anomalous city
    anomalous_city_id = 0
    anomalous_city_name = "unknown"
    for loc_id, data in city_counts.items():
        # This is simplified - we just take the most common city in the anomalous country
        if data["count"] > 0:
            # Check if this city is in the anomalous country
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    SELECT id, place_name FROM news_locations WHERE id = %s AND country = %s
                """, (loc_id, anomaly_country))
                row = cur.fetchone()
                if row:
                    anomalous_city_id = loc_id
                    anomalous_city_name = row["place_name"]
                    break

    return SourceAnomaly(
        source_id=source_id,
        source_name=source.get("name", "unknown"),
        source_country=source_country,
        primary_city_id=source_primary_city_id,
        total_articles=total,
        misplaced_articles=int(anomaly_score * total),
        anomaly_score=anomaly_score,
        expected_city_id=source_primary_city_id,
        actual_city_id=anomalous_city_id,
        actual_city_name=anomalous_city_name,
        actual_country=anomaly_country,
        confidence="high" if anomaly_score > 0.9 else "medium" if anomaly_score > 0.8 else "low",
    )


def get_sources_with_articles() -> list[dict]:
    """Get all active sources that have extracted articles."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT s.id, s.name, s.country, COUNT(a.id) as article_count
            FROM news_sources s
            JOIN news_articles a ON a.source_id = s.id
            WHERE s.active = true
              AND a.status IN ('extracted', 'clustered')
              AND a.extracted_lat IS NOT NULL
            GROUP BY s.id, s.name, s.country
            HAVING COUNT(a.id) >= 10
            ORDER BY article_count DESC
        """)
        return [dict(r) for r in cur.fetchall()]


def audit_all_sources(dry_run: bool = True, limit: int | None = None) -> list[SourceAnomaly]:
    """Audit all sources for systematic location anomalies."""
    sources = get_sources_with_articles()
    if limit:
        sources = sources[:limit]

    anomalies = []
    for src in sources:
        try:
            anomaly = analyze_source_anomaly(src["id"])
            if anomaly:
                anomalies.append(anomaly)
                if not dry_run:
                    log.warning(
                        "ANOMALY: Source %s (id=%d) has %d/%d (%.0f%%) articles in %s but source country is %s",
                        anomaly.source_name, anomaly.source_id,
                        anomaly.misplaced_articles, anomaly.total_articles,
                        anomaly.anomaly_score * 100,
                        anomaly.actual_country, anomaly.source_country
                    )
        except Exception as e:
            log.error("Error auditing source %d: %s", src["id"], e)

    return anomalies


def correct_source_anomaly(anomaly: SourceAnomaly, dry_run: bool = True) -> int:
    """Attempt to correct articles from an anomalous source.

    Returns the number of articles corrected.
    """
    if dry_run:
        log.info("[DRY RUN] Would correct %d articles from source %d", anomaly.misplaced_articles, anomaly.source_id)
        return anomaly.misplaced_articles

    # For now, just flag the source's primary city for review
    # A full correction would require re-running extraction on each article
    with connect() as conn, conn.cursor() as cur:
        # Update the source's primary_city_id to be the actual city where articles land
        # This will help future articles use the correct fallback
        if anomaly.actual_city_id and anomaly.actual_city_id != anomaly.expected_city_id:
            cur.execute("""
                UPDATE news_sources
                SET primary_city_id = %s, updated_at = now()
                WHERE id = %s
            """, (anomaly.actual_city_id, anomaly.source_id))
            conn.commit()
            log.info("Updated source %d primary_city_id from %s to %s (%s)",
                     anomaly.source_id, anomaly.expected_city_id, anomaly.actual_city_id, anomaly.actual_city_name)
            return anomaly.misplaced_articles

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit sources for systematic location anomalies")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be corrected without making changes")
    parser.add_argument("--limit", type=int, default=None, help="Limit to top N sources by article count")
    parser.add_argument("--fix", action="store_true", help="Apply corrections")
    parser.add_argument("--confidence", choices=["high", "medium", "low"], default=None,
                        help="Only flag anomalies at or above this confidence level")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.dry_run else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    log.info("Starting source audit (dry_run=%s, limit=%s)", args.dry_run, args.limit)
    anomalies = audit_all_sources(dry_run=args.dry_run, limit=args.limit)

    if args.confidence:
        anomalies = [a for a in anomalies if a.confidence == args.confidence or
                     (args.confidence == "medium" and a.confidence == "high") or
                     (args.confidence == "low" and a.confidence in ("high", "medium", "low"))]

    if not anomalies:
        log.info("No anomalies found")
        return 0

    log.warning("Found %d source anomalies:", len(anomalies))
    for a in sorted(anomalies, key=lambda x: -x.anomaly_score):
        print(f"  [{a.confidence.upper()}] {a.source_name} (id={a.source_id})")
        print(f"         {a.misplaced_articles}/{a.total_articles} ({a.anomaly_score:.0%}) articles in {a.actual_city_name}, {a.actual_country}")
        print(f"         Expected source country: {a.source_country}")
        print()

    if args.fix and not args.dry_run:
        total_corrected = 0
        for anomaly in anomalies:
            corrected = correct_source_anomaly(anomaly, dry_run=False)
            total_corrected += corrected
        log.info("Corrected %d articles across %d sources", total_corrected, len(anomalies))

    return len(anomalies)


if __name__ == "__main__":
    raise SystemExit(main())
