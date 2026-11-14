"""Knowledge Gap Detector — deterministic WHO/WHAT/WHEN/WHERE/WHY/HOW/IMPACT/CASUALTIES/RESPONSE checklist.

Rule: never use Gemma for something SQL/regex can determine.

Run:
    python3 -m worker.knowledge_gap_detector --dry-run
    python3 -m worker.knowledge_gap_detector --event-id 1234
    python3 -m worker.knowledge_gap_detector --limit 500
"""
from __future__ import annotations

import json
import logging
import re
import sys
from dataclasses import dataclass
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.kg_detector")

DIMENSIONS = [
    "who",       # persons, organizations involved
    "what",      # what happened (headline/event_type confirms)
    "when",      # date/time of event
    "where",     # geographic location
    "why",       # cause, reason, motivation
    "how",       # mechanism, process, method
    "impact",    # consequences, damage, effects
    "casualties",# death/injury counts
    "response",  # official/military/diplomatic response
    "next",      # what happens next, predictions
    "evidence",  # sources, proof, documentation
]

# ── Keyword sets for dimension detection ──────────────────────────────
CASUALTY_PATTERNS = [
    (re.compile(r"\b(\d[\d,]*)\s+(?:people\s+)?(killed|deaths?|dead|fatalities?)", re.I), 1),
    (re.compile(r"\b(\d[\d,]*)\s+(?:people\s+)?(injured|wounded|hurt|missing)", re.I), 1),
    (re.compile(r"\b(\d[\d,]*)\s+(?:people\s+)?(missing|displaced|evacuated)", re.I), 1),
    (re.compile(r"casualties?\s*(?:of|:)?\s*(\d[\d,]*)", re.I), 1),
    (re.compile(r"death\s*toll\s*(?:of|:)?\s*(\d[\d,]*)", re.I), 1),
    (re.compile(r"\b(\d[\d,]*)\s+(?:soldiers?|civilians?|troops?|police|officers?)\s+(?:killed|dead|wounded)", re.I), 1),
    (re.compile(r"(\d+)\s+(?:houses?|buildings?|homes?)\s+(?:destroyed|damaged)", re.I), 2),
    (re.compile(r"(\d+)\s+(?: hectares?|acres?|km²)\s+(?:of\s+)?(?:forest|land|crops?)\s+(?:burned|damaged|affected)", re.I), 2),
]

RESPONSE_PATTERNS = [
    re.compile(r"\b(said|stated|announced|declared|ordered|deployed|approved|rejected|refused)\b", re.I),
    re.compile(r"\b(government|military|police|president|minister|official|authorities)\s+\w+\s+(?:that\s+)?", re.I),
    re.compile(r"(emergency|killed|wounded|injured|dead)\s+(and|or)\s+(?:the\s+)?(response|aid|rescue|evacuation)", re.I),
    re.compile(r"\b(联合国|政府|军队|警方|官方)\b", 0),  # Chinese: government/military/police/official
]

WHY_PATTERNS = [
    re.compile(r"\b(because|due to|caused by|result of|reason|reason for|motive|motivation|purpose)\b", re.I),
    re.compile(r"\b(in order to|for the purpose of|aiming to|targeting)\b", re.I),
    re.compile(r"\b(retaliation|revenge|revenge|dispute|conflict over|tension)\b", re.I),
]

HOW_PATTERNS = [
    re.compile(r"\b(using|via|through|by means of|by launching|by conducting|by carrying out)\b", re.I),
    re.compile(r"\b(drone|missile|artillery|artillery|rocket|bomb|gunfire|attack)\b", re.I),
    re.compile(r"\b(exploded|detonated|fired|launched|struck|crashed|hijacked)\b", re.I),
]

IMPACT_PATTERNS = [
    re.compile(r"\b(damaged|destroyed|burned|collapsed|evacuated|displaced)\b", re.I),
    re.compile(r"\b(power outage|internet outage|communication blackout|roads blocked)\b", re.I),
    re.compile(r"\b(prices?|stocks?|economy|market|supply chain|shipping)\b", re.I),
    re.compile(r"\b(school[sz]?\s+(?:closed|open)|businesses?\s+(?:closed|open))\b", re.I),
]

NEXT_PATTERNS = [
    re.compile(r"\b(will|would|could|may|might|expected to|plans? to|intends? to)\b", re.I),
    re.compile(r"\b(investigation|trial|hearing|talks?|negotiations?|summit|meeting)\s+(?:will|to|is\s+scheduled)\b", re.I),
    re.compile(r"\b(future|coming (?:days|weeks|months)|upcoming|next (?:steps?|phase))\b", re.I),
]

WHERE_PATTERNS = [
    re.compile(r"\b(city|province|region|state|country|district|area|coordinates?)\b", re.I),
    re.compile(r"\b(north|south|east|west|southeast|northeast|southwest|northwest)\s+of\b", re.I),
]


@dataclass
class KnowledgeGap:
    dimension: str
    status: str          # missing | partial | confirmed | disputed
    confidence: float
    claim: Optional[str]
    supporting_article_ids: list[int]


def extract_dimension(
    articles: list[dict],
    patterns: list,
    min_match_fraction: float = 0.1,
) -> tuple[str, float, Optional[str]]:
    """Return (status, confidence, first_claim_text)."""
    if not articles:
        return "missing", 0.0, None

    matched = 0
    claim_texts: list[str] = []

    for art in articles:
        body = (art.get("title", "") + " " + (art.get("body", "") or ""))[:5000]
        for pat in patterns:
            if isinstance(pat, tuple):
                regex, _ = pat
            else:
                regex = pat
            m = regex.search(body)
            if m:
                matched += 1
                if isinstance(pat, tuple) and len(m.groups()) >= 1:
                    claim_texts.append(m.group(0))
                break

    frac = matched / len(articles)
    if frac >= min_match_fraction:
        return "confirmed", min(0.95, 0.5 + frac), (claim_texts[0] if claim_texts else None)
    elif frac >= min_match_fraction / 3:
        return "partial", min(0.5, frac * 2), None
    else:
        return "missing", frac, None


def detect_gaps(event_id: int, article_ids: list[int]) -> list[KnowledgeGap]:
    if not article_ids:
        return [KnowledgeGap(d, "missing", 0.0, None, []) for d in DIMENSIONS]

    placeholders = ",".join(["%s"] * len(article_ids))
    with connect() as conn:
        rows = conn.execute(f"""
            SELECT
                a.id, a.title, a.body, a.published_at,
                a.extracted_location, a.extracted_lat, a.extracted_lng,
                a.extracted_event_type, a.entities,
                e.occurred_at, e.first_reported_at,
                s.id AS source_id, s.name AS source_name,
                s.country AS source_country
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            LEFT JOIN news_events e ON e.id = %s
            WHERE a.id IN ({placeholders})
              AND a.hidden_at IS NULL
        """, (event_id, *article_ids)).fetchall()

    if not rows:
        return [KnowledgeGap(d, "missing", 0.0, None, []) for d in DIMENSIONS]

    articles = [dict(r) for r in rows]

    gaps: list[KnowledgeGap] = []

    # ── WHO ────────────────────────────────────────────────────────────
    all_entities: set[str] = set()
    for art in articles:
        for ent in (art.get("entities") or []):
            if ent and len(ent) > 2:
                all_entities.add(ent.lower())
    if len(all_entities) >= 2:
        gaps.append(KnowledgeGap("who", "confirmed", 0.9, f"{len(all_entities)} entities identified", []))
    elif len(all_entities) == 1:
        gaps.append(KnowledgeGap("who", "partial", 0.5, list(all_entities)[0], []))
    else:
        gaps.append(KnowledgeGap("who", "missing", 0.2, None, [a["id"] for a in articles[:3]]))

    # ── WHAT ──────────────────────────────────────────────────────────
    event_type = rows[0].get("extracted_event_type") if rows else None
    headline = rows[0].get("title") if rows else None
    if event_type or headline:
        gaps.append(KnowledgeGap("what", "confirmed", 0.95, event_type or headline[:100], []))
    else:
        gaps.append(KnowledgeGap("what", "missing", 0.3, None, [a["id"] for a in articles[:3]]))

    # ── WHEN ──────────────────────────────────────────────────────────
    occurred_at = rows[0].get("occurred_at") if rows else None
    published_at = rows[0].get("published_at") if rows else None
    if occurred_at:
        gaps.append(KnowledgeGap("when", "confirmed", 0.95, str(occurred_at)[:10], []))
    elif published_at:
        gaps.append(KnowledgeGap("when", "partial", 0.6, f"reported {published_at}", []))
    else:
        gaps.append(KnowledgeGap("when", "missing", 0.2, None, [a["id"] for a in articles[:3]]))

    # ── WHERE ─────────────────────────────────────────────────────────
    lat = rows[0].get("extracted_lat") if rows else None
    lng = rows[0].get("extracted_lng") if rows else None
    location_text = rows[0].get("extracted_location") if rows else None
    if lat is not None and lng is not None:
        gaps.append(KnowledgeGap("where", "confirmed", 0.9, f"{lat},{lng}", []))
    elif location_text:
        gaps.append(KnowledgeGap("where", "partial", 0.6, location_text, []))
    else:
        gaps.append(KnowledgeGap("where", "missing", 0.2, None, [a["id"] for a in articles[:3]]))

    # ── WHY ──────────────────────────────────────────────────────────
    status, conf, claim = extract_dimension(articles, WHY_PATTERNS)
    gaps.append(KnowledgeGap("why", status, conf, claim, [a["id"] for a in articles[:3] if not claim]))

    # ── HOW ──────────────────────────────────────────────────────────
    status, conf, claim = extract_dimension(articles, HOW_PATTERNS)
    gaps.append(KnowledgeGap("how", status, conf, claim, [a["id"] for a in articles[:3] if not claim]))

    # ── IMPACT ───────────────────────────────────────────────────────
    status, conf, claim = extract_dimension(articles, IMPACT_PATTERNS)
    gaps.append(KnowledgeGap("impact", status, conf, claim, [a["id"] for a in articles[:3] if not claim]))

    # ── CASUALTIES ───────────────────────────────────────────────────
    status, conf, claim = extract_dimension(articles, CASUALTY_PATTERNS)
    gaps.append(KnowledgeGap("casualties", status, conf, claim, [a["id"] for a in articles[:3] if not claim]))

    # ── RESPONSE ─────────────────────────────────────────────────────
    status, conf, claim = extract_dimension(articles, RESPONSE_PATTERNS)
    gaps.append(KnowledgeGap("response", status, conf, claim, [a["id"] for a in articles[:3] if not claim]))

    # ── NEXT ─────────────────────────────────────────────────────────
    status, conf, _ = extract_dimension(articles, NEXT_PATTERNS)
    gaps.append(KnowledgeGap("next", status if status == "confirmed" else "missing",
                              conf if status == "confirmed" else 0.1,
                              None, [a["id"] for a in articles[:3]]))

    # ── EVIDENCE ─────────────────────────────────────────────────────
    # Always gap unless we have multiple independent sources
    unique_sources = len(set(a["source_id"] for a in articles if a.get("source_id")))
    if unique_sources >= 3:
        gaps.append(KnowledgeGap("evidence", "confirmed", 0.8,
                                  f"{unique_sources} independent sources", []))
    elif unique_sources == 2:
        gaps.append(KnowledgeGap("evidence", "partial", 0.5, "2 sources", []))
    else:
        gaps.append(KnowledgeGap("evidence", "missing", 0.2, None,
                                  [a["id"] for a in articles[:3]]))

    return gaps


def process_event(event_id: int) -> dict:
    with connect() as conn:
        article_ids = [
            r["id"] for r in conn.execute("""
                SELECT a.id FROM news_articles a
                JOIN news_event_sources es ON es.article_id = a.id
                WHERE es.event_id = %s
                  AND a.hidden_at IS NULL
                  AND a.status = 'extracted'
            """, (event_id,)).fetchall()
        ]

    if not article_ids:
        return {"event_id": event_id, "gaps": 0}

    gaps = detect_gaps(event_id, article_ids)

    with connect() as conn:
        for g in gaps:
            conn.execute("""
                INSERT INTO news_event_knowledge_gaps (
                    event_id, dimension, status, confidence, claim, source_ids
                )
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (event_id, dimension) DO UPDATE SET
                    status     = EXCLUDED.status,
                    confidence = GREATEST(news_event_knowledge_gaps.confidence, EXCLUDED.confidence),
                    claim      = COALESCE(EXCLUDED.claim, news_event_knowledge_gaps.claim),
                    filled_at  = CASE WHEN EXCLUDED.status IN ('confirmed','partial')
                                      AND news_event_knowledge_gaps.status = 'missing'
                                      THEN NOW() ELSE news_event_knowledge_gaps.filled_at END
            """, (
                event_id, g.dimension, g.status, g.confidence,
                g.claim, g.supporting_article_ids[:5] if g.supporting_article_ids else None,
            ))
        conn.commit()

    missing = sum(1 for g in gaps if g.status == "missing")
    partial = sum(1 for g in gaps if g.status == "partial")
    confirmed = sum(1 for g in gaps if g.status == "confirmed")
    return {
        "event_id": event_id,
        "gaps": len(gaps),
        "missing": missing,
        "partial": partial,
        "confirmed": confirmed,
    }


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
              AND es.event_id NOT IN (
                  SELECT event_id FROM news_event_knowledge_gaps
              )
              AND es.event_id IN (
                  SELECT id FROM news_events WHERE status = 'active'
              )
            ORDER BY es.event_id DESC
            LIMIT %s
        """, (limit,)).fetchall()

    event_ids = [r["event_id"] for r in rows]
    log.info("kg_detector: processing %d events", len(event_ids))

    totals = {"events": len(event_ids), "missing": 0, "partial": 0, "confirmed": 0, "errors": 0}
    for eid in event_ids:
        try:
            result = process_event(eid)
            totals["missing"] += result["missing"]
            totals["partial"] += result["partial"]
            totals["confirmed"] += result["confirmed"]
        except Exception as ex:
            log.warning("KG error event %d: %s", eid, ex)
            totals["errors"] += 1

    log.info(
        "kg_detector: %d events — missing=%d partial=%d confirmed=%d",
        totals["events"], totals["missing"], totals["partial"], totals["confirmed"]
    )
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
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        log.info("Dry run")
    else:
        result = run(event_id=args.event_id, limit=args.limit)
        print(json.dumps(result))
