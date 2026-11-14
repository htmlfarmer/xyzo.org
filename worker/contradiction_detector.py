"""Contradiction Engine — detect conflicting claims within events.

Rule: never ask Gemma to compare two numbers. Code can detect that
"5 killed" and "10 killed" contradict each other.

Contradiction types:
  - casualty: different death/injury counts for same event
  - location: different geographic locations for same event
  - date: different dates/times for same event
  - scale: vastly different magnitude estimates
  - finding: confirmed vs. denied vs. unconfirmed
  - impact: conflicting impact assessments

Run:
    python3 -m worker.contradiction_detector --limit 500
    python3 -m worker.contradiction_detector --event-id 1234
"""
from __future__ import annotations

import json
import logging
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.contradiction")

# ── Claim extraction patterns ─────────────────────────────────────────
CASUALTY_PATTERNS = [
    re.compile(r"\b(\d[\d,]*)\s+(?:people\s+)?(?:killed?|deaths?|dead|fatalities?)", re.I),
    re.compile(r"\b(\d[\d,]*)\s+(?:people\s+)?(?:injured|wounded|hurt)", re.I),
    re.compile(r"\b(\d[\d,]*)\s+(?:people\s+)?(?:missing|displaced|evacuated)", re.I),
    re.compile(r"casualties?\s*(?:of|:)?\s*(\d[\d,]*)", re.I),
    re.compile(r"death\s*toll\s*(?:of|:)?\s*(\d[\d,]*)", re.I),
    re.compile(r"\b(\d[\d,]*)\s+(?:soldiers?|civilians?|troops?|police)\s+(?:killed|dead)", re.I),
]

LOCATION_PATTERNS = [
    re.compile(r"\b(?:in|near|at|outside|inside)\s+([A-Z][a-zA-Z\s]+?(?:city|province|region|state|county|district|area)?)", re.I),
    re.compile(r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:region|province|state|city)", re.I),
]

DATE_PATTERNS = [
    re.compile(r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}", re.I),
    re.compile(r"\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b", re.I),
    re.compile(r"\b(?:on |at |by )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I),
]

DENIAL_PATTERNS = [
    re.compile(r"\b(no\s+(?:casualties?|deaths?|injuries?|damage))\b", re.I),
    re.compile(r"\b(denied|denies|denial|unconfirmed|not\s+confirmed)\b", re.I),
    re.compile(r"\b(alleged|allegedly|rumored|rumoured)\b", re.I),
    re.compile(r"\b(zero|0)\s+(?:casualties?|deaths?)\b", re.I),
]

CONFIRMATION_PATTERNS = [
    re.compile(r"\b(\d+)\s+(?:confirmed|casualties?|deaths?)\b", re.I),
    re.compile(r"\b(confirmed|verified|official)\s+(?:\d+\s+)?(?:casualties?|deaths?)\b", re.I),
]

MAGNITUDE_PATTERNS = [
    re.compile(r"\b(magnitude|richter)\s*(\d+\.?\d*)\b", re.I),
    re.compile(r"\b(\d+\.?\d*)\s*(?:magnitude|richter)\b", re.I),
    re.compile(r"\b(\d+)\s*(?:hectares?|acres?|km²)\s+(?:of\s+)?(?:burned|damaged|affected)", re.I),
    re.compile(r"\b(\d+)\s+(?:buildings?|houses?|homes?)\s+(?:destroyed|damaged)", re.I),
]


@dataclass
class ExtractedClaim:
    article_id: int
    source_id: int
    claim_type: str       # casualty|location|date|denial|magnitude|scale
    claim_text: str
    numeric_value: Optional[float]
    unit: Optional[str]
    confidence: float


def _html_decode(text: str) -> str:
    """Decode common HTML entities."""
    return (text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#039;", "'")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )


def extract_claims(event_id: int, article_ids: list[int]) -> list[ExtractedClaim]:
    """Extract all structured claims from articles in an event."""
    if not article_ids:
        return []

    placeholders = ",".join(["%s"] * len(article_ids))
    with connect() as conn:
        rows = conn.execute(f"""
            SELECT a.id, a.title, a.body, s.id AS source_id, s.name AS source_name
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.id IN ({placeholders})
              AND a.hidden_at IS NULL
              AND a.status = 'extracted'
        """, (*article_ids,)).fetchall()

    claims: list[ExtractedClaim] = []

    for r in rows:
        art_id = r["id"]
        src_id = r["source_id"]
        title = _html_decode(r["title"] or "")
        body = _html_decode(r["body"] or "")
        # Search in title + body; title often contains the key claim
        search_text = title + " " + body
        text500 = search_text[:500]
        text1000 = search_text[:1000]

        # ── Casualty claims ───────────────────────────────────────
        for pat in CASUALTY_PATTERNS:
            m = pat.search(text500)
            if m:
                num_str = m.group(1).replace(",", "")
                try:
                    num_val = float(num_str)
                    is_denial = False
                    for dp in DENIAL_PATTERNS:
                        if dp.search(text500):
                            is_denial = True
                            break
                    claims.append(ExtractedClaim(
                        article_id=art_id,
                        source_id=src_id,
                        claim_type="casualty",
                        claim_text=m.group(0),
                        numeric_value=num_val if not is_denial else 0.0,
                        unit="people",
                        confidence=0.75,
                    ))
                    break  # only one casualty claim per article
                except ValueError:
                    pass

        # ── Denial / unconfirmed claims ───────────────────────────
        for pat in DENIAL_PATTERNS:
            m = pat.search(text500)
            if m:
                claims.append(ExtractedClaim(
                    article_id=art_id,
                    source_id=src_id,
                    claim_type="denial",
                    claim_text=m.group(0),
                    numeric_value=0.0,
                    unit=None,
                    confidence=0.65,
                ))
                break

        # ── Confirmation claims ───────────────────────────────────
        for pat in CONFIRMATION_PATTERNS:
            m = pat.search(text500)
            if m:
                claims.append(ExtractedClaim(
                    article_id=art_id,
                    source_id=src_id,
                    claim_type="confirmed",
                    claim_text=m.group(0),
                    numeric_value=None,
                    unit=None,
                    confidence=0.80,
                ))
                break

        # ── Location claims ──────────────────────────────────────
        for pat in LOCATION_PATTERNS:
            m = pat.search(text500)
            if m:
                loc = m.group(1).strip()
                if len(loc) > 2 and len(loc) < 60:
                    claims.append(ExtractedClaim(
                        article_id=art_id,
                        source_id=src_id,
                        claim_type="location",
                        claim_text=loc,
                        numeric_value=None,
                        unit=None,
                        confidence=0.70,
                    ))
                    break

        # ── Date claims ─────────────────────────────────────────
        for pat in DATE_PATTERNS:
            m = pat.search(text500)
            if m:
                claims.append(ExtractedClaim(
                    article_id=art_id,
                    source_id=src_id,
                    claim_type="date",
                    claim_text=m.group(0),
                    numeric_value=None,
                    unit=None,
                    confidence=0.70,
                ))
                break

        # ── Magnitude claims ────────────────────────────────────
        for pat in MAGNITUDE_PATTERNS:
            m = pat.search(text500)
            if m:
                try:
                    val = float(m.group(2) if m.lastindex and m.group(2) else m.group(1))
                    claims.append(ExtractedClaim(
                        article_id=art_id,
                        source_id=src_id,
                        claim_type="magnitude",
                        claim_text=m.group(0),
                        numeric_value=val,
                        unit="magnitude" if "magnitude" in m.group(0).lower() or "richter" in m.group(0).lower() else None,
                        confidence=0.80,
                    ))
                except ValueError:
                    pass
                break

    return claims


def detect_contradictions(event_id: int, claims: list[ExtractedClaim]) -> list[tuple[int, int, str, str]]:
    """Detect pairs of contradictory claims.

    Returns list of (claim_a_id, claim_b_id, reason, claim_type).
    """
    contradictions: list[tuple[int, int, str, str]] = []

    # Group by type
    by_type: dict[str, list[ExtractedClaim]] = defaultdict(list)
    for c in claims:
        by_type[c.claim_type].append(c)

    # Casualty contradictions: different non-zero values
    casualty_claims = by_type.get("casualty", [])
    for i in range(len(casualty_claims)):
        for j in range(i + 1, len(casualty_claims)):
            ca, cb = casualty_claims[i], casualty_claims[j]
            if ca.numeric_value and cb.numeric_value:
                ratio = max(ca.numeric_value, cb.numeric_value) / max(min(ca.numeric_value, cb.numeric_value), 0.1)
                if ratio >= 1.5:  # 50% or more discrepancy
                    contradictions.append((
                        ca.article_id, cb.article_id,
                        f"Casualty discrepancy: {ca.claim_text} vs {cb.claim_text}",
                        "casualty"
                    ))

    # Casualty vs. Denial contradictions
    denial_claims = by_type.get("denial", [])
    if casualty_claims and denial_claims:
        for ca in casualty_claims:
            for cb in denial_claims:
                if ca.numeric_value and ca.numeric_value > 0:
                    contradictions.append((
                        ca.article_id, cb.article_id,
                        f"Casualty confirmed ({ca.claim_text}) but denial reported ({cb.claim_text})",
                        "finding"
                    ))

    # Location contradictions: different locations
    location_claims = by_type.get("location", [])
    location_texts: dict[str, list[ExtractedClaim]] = defaultdict(list)
    for c in location_claims:
        loc_key = c.claim_text.lower().strip()
        location_texts[loc_key].append(c)

    loc_keys = list(location_texts.keys())
    for i in range(len(loc_keys)):
        for j in range(i + 1, len(loc_keys)):
            # Skip if one location is contained in the other
            ki, kj = loc_keys[i], loc_keys[j]
            if ki in kj or kj in ki:
                continue
            contradictions.append((
                location_texts[ki][0].article_id,
                location_texts[kj][0].article_id,
                f"Location discrepancy: {ki} vs {kj}",
                "location"
            ))

    # Magnitude contradictions
    mag_claims = by_type.get("magnitude", [])
    for i in range(len(mag_claims)):
        for j in range(i + 1, len(mag_claims)):
            ma, mb = mag_claims[i], mag_claims[j]
            if ma.numeric_value and mb.numeric_value:
                ratio = max(ma.numeric_value, mb.numeric_value) / max(min(ma.numeric_value, mb.numeric_value), 0.1)
                if ratio >= 1.3:
                    contradictions.append((
                        ma.article_id, mb.article_id,
                        f"Magnitude discrepancy: {ma.claim_text} vs {mb.claim_text}",
                        "magnitude"
                    ))

    return contradictions


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
        return {"event_id": event_id, "claims": 0, "contradictions": 0}

    claims = extract_claims(event_id, article_ids)
    contradictions = detect_contradictions(event_id, claims)

    claim_map: dict[int, ExtractedClaim] = {}
    for c in claims:
        claim_map[c.article_id] = c

    contradiction_article_pairs: set[tuple[int, int]] = set()
    for ca_id, cb_id, reason, ctype in contradictions:
        contradiction_article_pairs.add((ca_id, cb_id))

    with connect() as conn:
        # Upsert claims
        for c in claims:
            conn.execute("""
                INSERT INTO news_event_claims (
                    event_id, claim_type, claim_text, numeric_value, unit,
                    confidence, source_id, article_id, status
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'unverified')
                ON CONFLICT DO NOTHING
            """, (
                event_id, c.claim_type, c.claim_text,
                c.numeric_value, c.unit, c.confidence,
                c.source_id, c.article_id,
            ))

        # Update claims involved in contradictions
        for ca_id, cb_id, reason, ctype in contradictions:
            # Mark both claims as disputed
            for art_id in [ca_id, cb_id]:
                conn.execute("""
                    UPDATE news_event_claims SET
                        status = 'disputed',
                        contradicted_sources = array[
                            COALESCE(contradicted_sources, ARRAY[]::bigint[])
                            || (
                                SELECT ARRAY_AGG(DISTINCT source_id)
                                FROM news_articles a2
                                JOIN news_event_sources es2 ON es2.article_id = a2.id
                                WHERE es2.event_id = %s
                                  AND a2.id != %s
                                  AND a2.source_id != (
                                      SELECT source_id FROM news_articles WHERE id = %s
                                  )
                            )
                        ]
                    WHERE event_id = %s AND article_id = %s
                      AND status = 'unverified'
                """, (event_id, art_id, art_id, event_id, art_id))

        conn.commit()

    return {
        "event_id": event_id,
        "claims": len(claims),
        "contradictions": len(contradictions),
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
            ORDER BY es.event_id DESC
            LIMIT %s
        """, (limit,)).fetchall()

    event_ids = [r["event_id"] for r in rows]
    log.info("contradiction_detector: processing %d events", len(event_ids))

    totals = {"events": len(event_ids), "claims": 0, "contradictions": 0, "errors": 0}
    for eid in event_ids:
        try:
            result = process_event(eid)
            totals["claims"] += result["claims"]
            totals["contradictions"] += result["contradictions"]
        except Exception as ex:
            log.warning("Contradiction error event %d: %s", eid, ex)
            totals["errors"] += 1

    log.info(
        "contradiction_detector: %d events, %d claims, %d contradictions",
        totals["events"], totals["claims"], totals["contradictions"]
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
