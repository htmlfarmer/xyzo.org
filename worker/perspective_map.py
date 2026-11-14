"""Perspective Map — calculate who is talking for each event.

For each event, compute:
  - Source type breakdown: government/official, local media, international, researcher, company, NGO, citizen
  - Political perspective: domestic vs international sources
  - Language diversity
  - Coverage depth per source type

Run:
    python3 -m worker.perspective_map --limit 500
    python3 -m worker.perspective_map --event-id 1234
"""
from __future__ import annotations

import json
import logging
import sys

from .db import connect

log = logging.getLogger("xyzo.perspective_map")

# Source type classification
GOVERNMENT_TYPES = {"government", "official", "wire", "news-agency"}
LOCAL_TYPES = {"local", "regional", "community"}
INTERNATIONAL_TYPES = {"international", "global"}
RESEARCH_TYPES = {"academic", "research", "university"}
COMPANY_TYPES = {"company", "business", "corporate"}
NGO_TYPES = {"ngo", "nonprofit", "charity"}


def classify_source(source_name: str, source_country: str, url: str = "") -> str:
    name_lower = (source_name + " " + url).lower()
    if any(t in name_lower for t in GOVERNMENT_TYPES):
        return "government"
    if any(t in name_lower for t in LOCAL_TYPES):
        return "local"
    if any(t in name_lower for t in RESEARCH_TYPES):
        return "researcher"
    if any(t in name_lower for t in COMPANY_TYPES):
        return "company"
    if any(t in name_lower for t in NGO_TYPES):
        return "ngo"
    if any(t in name_lower for t in INTERNATIONAL_TYPES):
        return "international"
    # Heuristic: short country names + well-known global outlets
    global_outlets = {
        "reuters", "apnews", "afp", "bbc", "nytimes", "washington post",
        "the guardian", "cnn", "msnbc", "fox", "bloomberg", "npr",
        "al jazeera", "france24", "dw", "rt", "sputnik",
    }
    for outlet in global_outlets:
        if outlet in name_lower:
            return "international"
    return "local"


def process_event(event_id: int) -> dict:
    with connect() as conn:
        rows = conn.execute("""
            SELECT
                s.id AS source_id, s.name AS source_name,
                s.country AS source_country, s.source_type,
                s.language,
                es.article_id,
                COALESCE(syn.is_original, FALSE) AS is_original,
                COALESCE(syn.is_syndicated_copy, FALSE) AS is_syndicated_copy,
                a.published_at
            FROM news_event_sources es
            JOIN news_articles a ON a.id = es.article_id
            JOIN news_sources s ON s.id = a.source_id
            LEFT JOIN news_article_syndication syn ON syn.article_id = a.id
            WHERE es.event_id = %s
              AND a.hidden_at IS NULL
              AND a.status = 'extracted'
            ORDER BY a.published_at ASC NULLS LAST
        """, (event_id,)).fetchall()

    if not rows:
        return {"event_id": event_id}

    by_source: dict[int, dict] = {}
    for r in rows:
        sid = r["source_id"]
        if sid not in by_source:
            by_source[sid] = {
                "source_id": sid,
                "source_name": r["source_name"],
                "source_country": r["source_country"],
                "source_type": r["source_type"],
                "language": r["language"],
                "perspective": classify_source(
                    r["source_name"], r.get("source_country", ""), ""
                ),
                "article_count": 0,
                "original_articles": 0,
                "syndicated_articles": 0,
                "countries": set(),
                "languages": set(),
                "first_article_at": None,
                "last_article_at": None,
            }
        by_source[sid]["article_count"] += 1
        if r.get("is_original", False):
            by_source[sid]["original_articles"] += 1
        if r.get("is_syndicated_copy", False):
            by_source[sid]["syndicated_articles"] += 1
        by_source[sid]["countries"].add(r["source_country"])
        by_source[sid]["languages"].add(r["language"])
        pub = r["published_at"]
        if pub:
            if not by_source[sid]["first_article_at"] or pub < by_source[sid]["first_article_at"]:
                by_source[sid]["first_article_at"] = pub
            if not by_source[sid]["last_article_at"] or pub > by_source[sid]["last_article_at"]:
                by_source[sid]["last_article_at"] = pub

    sources = list(by_source.values())
    total_articles = sum(s["article_count"] for s in sources)

    # Aggregate by perspective
    perspective_counts: dict[str, dict] = {}
    for s in sources:
        p = s["perspective"]
        if p not in perspective_counts:
            perspective_counts[p] = {
                "perspective": p,
                "source_count": 0,
                "article_count": 0,
                "original_articles": 0,
                "countries": set(),
                "languages": set(),
            }
        perspective_counts[p]["source_count"] += 1
        perspective_counts[p]["article_count"] += s["article_count"]
        perspective_counts[p]["original_articles"] += s["original_articles"]
        perspective_counts[p]["countries"].update(s["countries"])
        perspective_counts[p]["languages"].update(s["languages"])

    # Coverage quality: percentage of original reporting
    total_original = sum(s["original_articles"] for s in sources)
    quality_score = total_original / max(total_articles, 1)

    # International vs domestic
    source_countries = {s["source_country"] for s in sources if s["source_country"]}
    primary_country = max(source_countries, key=lambda c: sum(
        1 for s in sources if s["source_country"] == c
    )) if source_countries else None

    domestic_sources = sum(1 for s in sources if s["source_country"] == primary_country)
    international_sources = len(sources) - domestic_sources

    # Languages
    all_languages = set()
    for s in sources:
        all_languages.update(s["languages"])

    perspective_breakdown = []
    for p, data in sorted(perspective_counts.items(), key=lambda x: -x[1]["article_count"]):
        pct = data["article_count"] / max(total_articles, 1)
        perspective_breakdown.append({
            "perspective": p,
            "source_count": data["source_count"],
            "article_count": data["article_count"],
            "pct_of_coverage": round(pct, 3),
            "original_sources": data["original_articles"],
            "country_count": len(data["countries"]),
            "language_count": len(data["languages"]),
        })

    result = {
        "event_id": event_id,
        "total_sources": len(sources),
        "total_articles": total_articles,
        "original_articles": total_original,
        "syndicated_articles": total_articles - total_original,
        "quality_score": round(quality_score, 3),
        "unique_countries": len(source_countries),
        "unique_languages": len(all_languages),
        "primary_country": primary_country,
        "domestic_sources": domestic_sources,
        "international_sources": international_sources,
        "perspective_breakdown": perspective_breakdown,
    }

    return result


def run(event_id: int | None = None, limit: int = 500) -> dict:
    if event_id:
        return process_event(event_id)

    with connect() as conn:
        rows = conn.execute("""
            SELECT DISTINCT es.event_id
            FROM news_event_sources es
            JOIN news_articles a ON a.id = es.article_id
            WHERE a.hidden_at IS NULL
              AND a.status = 'extracted'
              AND es.event_id IN (
                  SELECT id FROM news_events WHERE status = 'active'
              )
            ORDER BY es.event_id DESC
            LIMIT %s
        """, (limit,)).fetchall()

    event_ids = [r["event_id"] for r in rows]
    log.info("perspective_map: processing %d events", len(event_ids))

    totals = {"events": len(event_ids), "errors": 0}
    for eid in event_ids:
        try:
            process_event(eid)
        except Exception as ex:
            log.warning("Perspective error event %d: %s", eid, ex)
            totals["errors"] += 1

    log.info("perspective_map: done — %d events", totals["events"])
    return totals


if __name__ == "__main__":
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-id", type=int)
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args()

    result = run(event_id=args.event_id, limit=args.limit)
    print(json.dumps(result))
