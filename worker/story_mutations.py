"""Story Mutation Timeline — detect event evolution stages.

Stages: reported → confirmed → expanded → disputed → response → consequence → resolved/escalated

Deterministic rules:
  - reported: first article for this event
  - confirmed: 2+ independent sources confirm the core claim
  - expanded: articles add new locations/casualties/impact details
  - disputed: contradictory claims appear
  - response: official/government/military response detected
  - consequence: downstream effects mentioned
  - resolved: event has clear conclusion/outcome
  - escalated: event grows significantly (casualties increase, new countries involved)

Run:
    python3 -m worker.story_mutations --limit 500
    python3 -m worker.story_mutations --event-id 1234
"""
from __future__ import annotations

import json
import logging
import re
import sys
from collections import defaultdict
from dataclasses import dataclass

from .db import connect

log = logging.getLogger("xyzo.story_mutations")

STAGE_ORDER = [
    "reported", "confirmed", "expanded", "disputed", "response",
    "consequence", "resolved", "escalated"
]

CONFIRMATION_PATTERNS = [
    re.compile(r"\b(confirmed|confirmed by|verify|verified|official|source confirms)\b", re.I),
    re.compile(r"\b(corroborated|independently|multiple sources|according to)\b", re.I),
]

EXPANSION_PATTERNS = [
    re.compile(r"\b(additionally|furthermore|also|also reported|new details|updated)\b", re.I),
    re.compile(r"\b(spread to|expanded to|now in|reached|arrived in|crossed into)\b", re.I),
    re.compile(r"\b(magnitude revised|casualties (?:rose|increased|jumped)|death toll rises)\b", re.I),
    re.compile(r"\b(new (?:casualties|fires|damage|evacuations|arrests))\b", re.I),
]

DISPUTE_PATTERNS = [
    re.compile(r"\b(denied|denies|denial|dispute|disputed|contradict|contradicts|false|hoax|misinformation)\b", re.I),
    re.compile(r"\b(unconfirmed|unverified|uncertain|disputed|alleged|allegedly)\b", re.I),
    re.compile(r"\b(investigation|facts?|clarification|retraction)\b", re.I),
]

RESPONSE_PATTERNS = [
    re.compile(r"\b(government|president|minister|official|authorities|military|police)\s+\w+\s+(said|stated|announced|ordered|deployed|approved|rejected)\b", re.I),
    re.compile(r"\b(emergency (?:aid|response|meeting|session|declared)|UN\s+(?: Security Council)?\s+(?:met|called|convened))\b", re.I),
    re.compile(r"\b(sanctions?|condemn|condemnation|warned|warning)\b", re.I),
    re.compile(r"(美国|俄罗斯|乌克兰|北约|联合国)\s+.*?\s+(说|表示|宣布|警告)\b", 0),  # Chinese: US/Russia/Ukraine/NATO/UN + said/announced/warned
]

CONSEQUENCE_PATTERNS = [
    re.compile(r"\b(caused|led to|resulted in|triggered|stocks?\s+(?:fell|rose|plunged)|prices?\s+(?:rise|fall|jumped))\b", re.I),
    re.compile(r"\b(flights?\s+grounded|airspace\s+closed|roads?\s+blocked|power\s+outage)\b", re.I),
    re.compile(r"\b(markets?\s+(?:fell|plunged|tumbled)|economy\s+impact|inflation\s+(?:rose|jumped))\b", re.I),
    re.compile(r"\b(refugees?|displaced|evacuees?|humanitarian\s+crisis|aid\s+delivery)\b", re.I),
]

ESCALATION_PATTERNS = [
    re.compile(r"\b(escalated|escalation|widening|spreading|broadening|expanding)\b", re.I),
    re.compile(r"\b(nato\s+(?:involved|intervened|deploy|activates?|sends?))\b", re.I),
    re.compile(r"\b(civilian casualties|humanitarian\s+concern|war crimes?|genocide|atrocities?)\b", re.I),
    re.compile(r"\b(martial\s+law|state\s+of\s+emergency|mobilization|mobilise|mobilize)\b", re.I),
    re.compile(r"\b(nuclear\s+(?:threat|warning|accident|proliferation))\b", re.I),
]


@dataclass
class StageDetection:
    stage: str
    confidence: float
    evidence: str
    article_ids: list[int]


def detect_stages(event_id: int, article_ids: list[int]) -> list[StageDetection]:
    if len(article_ids) < 1:
        return []

    placeholders = ",".join(["%s"] * len(article_ids))
    with connect() as conn:
        rows = conn.execute(f"""
            SELECT
                a.id, a.title, a.body, a.published_at, a.fetched_at,
                s.id AS source_id, s.country AS source_country,
                a.extracted_lat, a.extracted_lng,
                COALESCE(a.entities, ARRAY[]::text[]) AS entities
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.id IN ({placeholders})
              AND a.hidden_at IS NULL
            ORDER BY a.published_at ASC NULLS LAST
        """, (*article_ids,)).fetchall()

    if not rows:
        return []

    articles = [dict(r) for r in rows]

    stages: list[StageDetection] = []

    # Stage 1: reported — always true for first article
    if articles:
        stages.append(StageDetection(
            stage="reported",
            confidence=1.0,
            evidence=f"First report from {articles[0].get('source_country', 'unknown')}",
            article_ids=[articles[0]["id"]]
        ))

    # Group articles by time buckets (1h, 3h, 6h, 12h, 24h)
    time_buckets: dict[str, list] = defaultdict(list)
    first_pub = articles[0].get("published_at") if articles else None

    for art in articles:
        pub = art.get("published_at")
        if first_pub and pub:
            delta_h = (pub - first_pub).total_seconds() / 3600
            if delta_h <= 1:
                time_buckets["1h"].append(art)
            elif delta_h <= 3:
                time_buckets["3h"].append(art)
            elif delta_h <= 6:
                time_buckets["6h"].append(art)
            elif delta_h <= 12:
                time_buckets["12h"].append(art)
            elif delta_h <= 24:
                time_buckets["24h"].append(art)
            else:
                time_buckets["24h+"].append(art)

    # Stage 2: confirmed — 2+ sources from different countries confirm core claim
    unique_countries = {a.get("source_country") for a in articles if a.get("source_country")}
    if len(unique_countries) >= 2:
        for art in articles:
            body = (art.get("title", "") + " " + (art.get("body") or ""))[:2000]
            if any(pat.search(body) for pat in CONFIRMATION_PATTERNS):
                stages.append(StageDetection(
                    stage="confirmed",
                    confidence=0.85,
                    evidence=f"Confirmed by {art.get('source_country')} source",
                    article_ids=[art["id"]]
                ))
                break
        else:
            stages.append(StageDetection(
                stage="confirmed",
                confidence=0.7,
                evidence=f"{len(unique_countries)} countries reporting",
                article_ids=[a["id"] for a in articles[:2]]
            ))

    # Stage 3: expanded — new details, casualties, locations in later articles
    later_articles = [a for a in articles[1:] if time_buckets.get("6h") and a in time_buckets["6h"]]
    for art in later_articles:
        body = (art.get("title", "") + " " + (art.get("body") or ""))[:2000]
        if any(pat.search(body) for pat in EXPANSION_PATTERNS):
            stages.append(StageDetection(
                stage="expanded",
                confidence=0.8,
                evidence="New details, locations, or casualty figures added",
                article_ids=[art["id"]]
            ))
            break
    else:
        # Fallback: later articles have new entities or locations
        if len(articles) > 3:
            early_entities = {e for a in articles[:2] for e in (a.get("entities") or [])}
            late_entities = {e for a in articles[2:] for e in (a.get("entities") or [])}
            new_entities = late_entities - early_entities
            if new_entities:
                stages.append(StageDetection(
                    stage="expanded",
                    confidence=0.6,
                    evidence=f"{len(new_entities)} new entities added in later coverage",
                    article_ids=[articles[2]["id"]]
                ))

    # Stage 4: disputed — contradictory or denial language
    dispute_articles = [
        a for a in articles
        if any(pat.search((a.get("title","")+" "+(a.get("body") or ""))[:2000]) for pat in DISPUTE_PATTERNS)
    ]
    if dispute_articles:
        stages.append(StageDetection(
            stage="disputed",
            confidence=0.75,
            evidence=f"Disputed/denied in {len(dispute_articles)} article(s)",
            article_ids=[dispute_articles[0]["id"]]
        ))

    # Stage 5: response — official response detected
    response_articles = [
        a for a in articles
        if any(pat.search((a.get("title","")+" "+(a.get("body") or ""))[:2000]) for pat in RESPONSE_PATTERNS)
    ]
    if response_articles:
        stages.append(StageDetection(
            stage="response",
            confidence=0.8,
            evidence=f"Official response in {response_articles[0].get('source_country', 'unknown')} coverage",
            article_ids=[response_articles[0]["id"]]
        ))

    # Stage 6: consequence — downstream effects
    consequence_articles = [
        a for a in articles
        if any(pat.search((a.get("title","")+" "+(a.get("body") or ""))[:2000]) for pat in CONSEQUENCE_PATTERNS)
    ]
    if consequence_articles:
        stages.append(StageDetection(
            stage="consequence",
            confidence=0.75,
            evidence=f"Downstream consequences reported",
            article_ids=[consequence_articles[0]["id"]]
        ))

    # Stage 7: escalated — major escalation signals
    escalation_articles = [
        a for a in articles
        if any(pat.search((a.get("title","")+" "+(a.get("body") or ""))[:2000]) for pat in ESCALATION_PATTERNS)
    ]
    if escalation_articles:
        stages.append(StageDetection(
            stage="escalated",
            confidence=0.85,
            evidence=f"Escalation signals: {escalation_articles[0].get('source_country', 'unknown')}",
            article_ids=[escalation_articles[0]["id"]]
        ))

    return stages


def process_event(event_id: int) -> dict:
    with connect() as conn:
        article_ids = [
            r["id"] for r in conn.execute("""
                SELECT a.id FROM news_articles a
                JOIN news_event_sources es ON es.article_id = a.id
                WHERE es.event_id = %s
                  AND a.hidden_at IS NULL
                  AND a.status = 'extracted'
                ORDER BY a.published_at ASC NULLS LAST
            """, (event_id,)).fetchall()
        ]

    if not article_ids:
        return {"event_id": event_id, "stages": 0}

    detected = detect_stages(event_id, article_ids)

    with connect() as conn:
        for d in detected:
            conn.execute("""
                INSERT INTO news_event_mutation (
                    event_id, stage, evidence, confidence
                )
                VALUES (%s,%s,%s,%s)
                ON CONFLICT (event_id, stage, occurred_at) DO UPDATE SET
                    evidence   = EXCLUDED.evidence,
                    confidence = GREATEST(news_event_mutation.confidence, EXCLUDED.confidence),
                    detected_at = NOW()
            """, (event_id, d.stage, d.evidence, d.confidence))
        conn.commit()

    return {
        "event_id": event_id,
        "stages": len(detected),
        "stage_names": [d.stage for d in detected],
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
              AND es.event_id IN (
                  SELECT id FROM news_events WHERE status = 'active'
              )
              AND es.event_id NOT IN (
                  SELECT event_id FROM news_event_mutation
                    GROUP BY event_id HAVING COUNT(*) >= 1
              )
            ORDER BY es.event_id DESC
            LIMIT %s
        """, (limit,)).fetchall()

    event_ids = [r["event_id"] for r in rows]
    log.info("story_mutations: processing %d events", len(event_ids))

    totals = {"events": len(event_ids), "stages": 0, "errors": 0}
    for eid in event_ids:
        try:
            result = process_event(eid)
            totals["stages"] += result["stages"]
        except Exception as ex:
            log.warning("Mutation error event %d: %s", eid, ex)
            totals["errors"] += 1

    log.info("story_mutations: %d events, %d stage detections",
             totals["events"], totals["stages"])
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
