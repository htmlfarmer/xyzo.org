"""Syndication Detector — detect original reporting vs. syndicated copies.

Architecture (no AI needed for core detection):
  1. Compute SimHash fingerprint for article body (normalized)
  2. Banded LSH to find candidate near-duplicate pairs fast
  3. Verify with full text similarity (Jaccard on word shingles)
  4. Determine original: earliest published + structural signals
  5. Build syndication graph (original → copies)

Run:
    python3 -m worker.syndication_detector --dry-run
    python3 -m worker.syndication_detector --limit 1000
    python3 -m worker.syndication_detector --event-id 1234
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.syndication")

# ── SimHash + LSH constants ──────────────────────────────────────────
BITS = 128
BANDS = 16
ROWS_PER_BAND = BITS // BANDS  # 8
JACCARD_THRESHOLD = 0.75       # articles above this are considered copies

# Known wire services — their articles are often syndicated elsewhere
WIRE_SERVICES = {
    "reuters.com", "reuters.info", "afp.com", "afpnews.com",
    "apnews.com", "apnews.co", "bloomberg.com", "bbc.co.uk",
    "bbc.com", "france24.com", "dw.com", "aljazeera.com",
}

# Boilerplate patterns to strip before fingerprinting
BOILERPLATE_PATTERNS = [
    re.compile(r"^(advertisement|advertisement\s*[-–—])", re.I),
    re.compile(r"^\s*(sign up|subscribe|newsletter|free trial)\s*[-–—].*$", re.I),
    re.compile(r"^(read more|related|you may also like|trending now)\s*[-–—].*$", re.I),
    re.compile(r"copyright\s*©?\s*\d{4}.*$", re.I),
    re.compile(r"all rights reserved", re.I),
    re.compile(r"share\s*[-–—]\s*(facebook|twitter|linkedin|email|whatsapp)", re.I),
    re.compile(r"https?://\S+\.(jpg|jpeg|png|gif|svg|webp)", re.I),
]

STOP_WORDS = {
    "a","an","the","and","or","but","in","on","at","to","for",
    "of","with","by","from","as","is","was","are","been","be",
    "have","has","had","do","does","did","will","would","could",
    "should","may","might","can","this","that","these","those",
    "it","its","they","them","their","we","our","you","your",
    "i","me","my","he","she","him","her","who","which","what",
    "when","where","why","how","not","no","yes","all","any",
    "some","more","most","other","such","so","than","too","very",
}


@dataclass
class SimHash:
    """128-bit SimHash with LSH banding."""
    values: list[int] = field(default_factory=lambda: [0] * BITS)

    @classmethod
    def from_text(cls, text: str) -> "SimHash":
        tokens = _tokenize(text)
        v = [0.0] * BITS
        for token in tokens:
            h = int(hashlib.sha256(token.encode()).hexdigest(), 16)
            for i in range(BITS):
                v[i] += 1 if (h >> i) & 1 else -1
        return cls(values=[1 if vi > 0 else 0 for vi in v])

    def hamming_distance(self, other: "SimHash") -> int:
        return sum(a ^ b for a, b in zip(self.values, other.values))

    def lsh_candidates(self, others: list[tuple[int, "SimHash"]]) -> list[int]:
        """Return IDs of hashes within Hamming distance 3 (i.e. same LSH band)."""
        candidates: set[int] = set()
        for band_i in range(BANDS):
            band_a = tuple(
                self.values[band_i * ROWS_PER_BAND : (band_i + 1) * ROWS_PER_BAND]
            )
            for other_id, other_hash in others:
                band_b = tuple(
                    other_hash.values[band_i * ROWS_PER_BAND : (band_i + 1) * ROWS_PER_BAND]
                )
                if band_a == band_b:
                    candidates.add(other_id)
        return list(candidates)

    def to_bytes(self) -> bytes:
        return bytes(
            sum(1 << i for i, v in enumerate(self.values) if v) % 256
            for _ in range(BITS // 8)
        )


def _normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^\w\s]", " ", text)
    for pat in BOILERPLATE_PATTERNS:
        text = pat.sub("", text)
    return text.strip()


def _tokenize(text: str) -> list[str]:
    tokens = _normalize(text).split()
    return [t for t in tokens if t not in STOP_WORDS and len(t) > 2]


def _shingles(text: str, k: int = 3) -> frozenset[str]:
    tokens = _tokenize(text)
    return frozenset(" ".join(tokens[i:i+k]) for i in range(len(tokens) - k + 1))


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union > 0 else 0.0


def _content_hash(text: str) -> str:
    norm = _normalize(text)
    return hashlib.sha256(norm.encode()).hexdigest()


def _boilerplate_similarity(body1: str, body2: str) -> bool:
    """Return True if both bodies share identical boilerplate regions."""
    common = ["advertisement", "subscribe", "newsletter", "copyright",
              "all rights reserved", "read more", "related articles"]
    b1l = body1.lower()[:500]
    b2l = body2.lower()[:500]
    matches = sum(1 for phrase in common if phrase in b1l and phrase in b2l)
    return matches >= 2


def _headline_template(title: str) -> str:
    """Normalize headline to template: numbers→N, caps→X, strip details."""
    t = re.sub(r"\d+", "N", title)
    t = re.sub(r"[A-Z]{2,}", "X", t)
    t = re.sub(r"[^\w\s]", "", t.lower())
    t = re.sub(r"\b(the|a|an|of|in|on|at|to|for|and|or|but)\b", "", t)
    return re.sub(r"\s+", " ", t).strip()


@dataclass
class SyndicationResult:
    article_id: int
    original_article_id: Optional[int]
    is_original: bool
    is_syndicated: bool
    confidence: float
    content_similarity: float
    structural_similarity: float
    chain_depth: int


def detect_syndication(event_article_ids: list[int]) -> list[SyndicationResult]:
    """Core syndication detection for a set of articles in the same event."""
    if len(event_article_ids) < 2:
        return []

    # Load article data
    placeholders = ",".join(["%s"] * len(event_article_ids))
    with connect() as conn:
        rows = conn.execute(f"""
            SELECT
                a.id, a.title, a.body, a.published_at, a.fetched_at,
                s.id AS source_id, s.name AS source_name,
                s.robots_allowed, s.source_type,
                sf.fingerprint IS NOT NULL AS has_fingerprint
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            LEFT JOIN news_article_fingerprints sf ON sf.article_id = a.id
            WHERE a.id IN ({placeholders})
              AND a.status = 'extracted'
              AND a.hidden_at IS NULL
              AND LENGTH(a.body) > 200
            ORDER BY a.published_at ASC NULLS LAST
        """, (*event_article_ids,)).fetchall()

    if len(rows) < 2:
        return []

    articles = []
    for r in rows:
        body = r["body"] or ""
        title = r["title"] or ""
        articles.append({
            "id": r["id"],
            "title": title,
            "body": body,
            "published_at": r["published_at"],
            "fetched_at": r["fetched_at"],
            "source_id": r["source_id"],
            "source_name": r["source_name"],
            "source_type": r["source_type"],
            "source_domain": _extract_domain(r["source_name"]),
            "content_hash": _content_hash(body),
            "headline_template": _headline_template(title),
            "body_length": len(body),
            "shingles": _shingles(body),
            "simhash": SimHash.from_text(body),
        })

    # Deduplicate by content_hash (exact duplicates first)
    seen_hash: dict[str, int] = {}
    for a in articles:
        if a["content_hash"] not in seen_hash:
            seen_hash[a["content_hash"]] = a["id"]

    results: list[SyndicationResult] = []
    originals: set[int] = set()
    copies: dict[int, tuple[int, float, float]] = {}  # copy_id → (original_id, sim, jaccard)

    # Build LSH index for fast candidate retrieval
    hash_index: list[tuple[int, SimHash]] = [
        (a["id"], a["simhash"]) for a in articles
    ]

    # Find near-duplicate pairs
    for i, a in enumerate(articles):
        if a["id"] in copies:
            continue

        candidates = a["simhash"].lsh_candidates(hash_index[:i] + hash_index[i+1:])

        for other in articles:
            if other["id"] == a["id"]:
                continue
            if other["id"] not in candidates:
                # Still check Hamming distance directly for boundary cases
                hd = a["simhash"].hamming_distance(other["simhash"])
                if hd > 3:
                    continue

            jaccard = _jaccard(a["shingles"], other["shingles"])
            if jaccard < JACCARD_THRESHOLD:
                continue

            # Structural signals
            same_headline = 1 if a["headline_template"] == other["headline_template"] else 0
            same_boiler = 1 if _boilerplate_similarity(a["body"], other["body"]) else 0
            structural = (same_headline * 0.4 + same_boiler * 0.6)

            # Wire service heuristic: wire service articles are almost always originals
            a_is_wire = a["source_domain"] in WIRE_SERVICES
            b_is_wire = other["source_domain"] in WIRE_SERVICES

            # Determine which is original
            a_first = (
                a["published_at"] is not None and other["published_at"] is not None
                and a["published_at"] <= other["published_at"]
            ) or (a["published_at"] is not None and other["published_at"] is None)

            # Wire service always wins as original
            if a_is_wire and not b_is_wire:
                original_id, copy_id = a["id"], other["id"]
                confidence = 0.95
            elif b_is_wire and not a_is_wire:
                original_id, copy_id = other["id"], a["id"]
                confidence = 0.95
            elif a_first:
                original_id, copy_id = a["id"], other["id"]
                confidence = 0.70 + structural * 0.20 + 0.05 * jaccard
            else:
                original_id, copy_id = other["id"], a["id"]
                confidence = 0.70 + structural * 0.20 + 0.05 * jaccard

            if copy_id not in copies or copies[copy_id][1] < jaccard:
                copies[copy_id] = (original_id, jaccard, structural)

    # Build results
    all_identified = set()
    for copy_id, (orig_id, jaccard, structural) in copies.items():
        results.append(SyndicationResult(
            article_id=copy_id,
            original_article_id=orig_id,
            is_original=False,
            is_syndicated=True,
            confidence=jaccard,
            content_similarity=jaccard,
            structural_similarity=structural,
            chain_depth=1,
        ))
        originals.add(orig_id)
        all_identified.add(copy_id)

    # Any article not in `copies` is original
    for a in articles:
        if a["id"] not in all_identified:
            results.append(SyndicationResult(
                article_id=a["id"],
                original_article_id=None,
                is_original=True,
                is_syndicated=False,
                confidence=1.0,
                content_similarity=1.0,
                structural_similarity=1.0,
                chain_depth=0,
            ))
            originals.add(a["id"])

    return results


def _extract_domain(source_name: str) -> str:
    name = source_name.lower()
    for wire in WIRE_SERVICES:
        if wire.replace("www.", "") in name.replace("www.", ""):
            return wire
    return ""


def process_event(event_id: int) -> dict:
    with connect() as conn:
        article_ids = [
            r["id"] for r in conn.execute("""
                SELECT a.id FROM news_articles a
                JOIN news_event_sources es ON es.article_id = a.id
                WHERE es.event_id = %s
                  AND a.hidden_at IS NULL
                  AND a.status = 'extracted'
                  AND LENGTH(a.body) > 200
            """, (event_id,)).fetchall()
        ]

    if not article_ids:
        return {"event_id": event_id, "articles": 0, "originals": 0, "copies": 0}

    results = detect_syndication(article_ids)

    originals = sum(1 for r in results if r.is_original)
    copies = sum(1 for r in results if r.is_syndicated)

    stats = {
        "event_id": event_id,
        "articles": len(results),
        "originals": originals,
        "copies": copies,
    }

    if not results:
        return stats

    with connect() as conn:
        for r in results:
            temporal_offset = None
            if r.original_article_id:
                offset_rows = conn.execute("""
                    SELECT EXTRACT(EPOCH FROM (
                        a.published_at - o.published_at
                    ))::bigint AS offset_seconds
                    FROM news_articles a, news_articles o
                    WHERE a.id = %s AND o.id = %s
                      AND a.published_at IS NOT NULL AND o.published_at IS NOT NULL
                """, (r.article_id, r.original_article_id)).fetchall()
                if offset_rows:
                    temporal_offset = offset_rows[0]["offset_seconds"]

            conn.execute("""
                INSERT INTO news_article_syndication (
                    article_id, original_article_id, is_original, is_syndicated_copy,
                    syndication_confidence, content_similarity, structural_similarity,
                    same_boilerplate, same_headline_template, temporal_offset_seconds,
                    syndication_chain_depth
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (article_id) DO UPDATE SET
                    original_article_id   = EXCLUDED.original_article_id,
                    is_original          = EXCLUDED.is_original,
                    is_syndicated_copy   = EXCLUDED.is_syndicated_copy,
                    syndication_confidence = EXCLUDED.syndication_confidence,
                    content_similarity   = EXCLUDED.content_similarity,
                    structural_similarity = EXCLUDED.structural_similarity,
                    temporal_offset_seconds = EXCLUDED.temporal_offset_seconds,
                    syndication_chain_depth = EXCLUDED.syndication_chain_depth,
                    detected_at = NOW()
            """, (
                r.article_id, r.original_article_id, r.is_original, r.is_syndicated,
                r.confidence, r.content_similarity, r.structural_similarity,
                r.structural_similarity > 0.5,  # same_boilerplate proxy
                r.structural_similarity > 0.3,  # same_headline proxy
                temporal_offset, r.chain_depth,
            ))
        conn.commit()

    return stats


def run(event_id: int | None = None, limit: int = 200, dry_run: bool = False) -> dict:
    """Run syndication detection on recent events or a specific event."""
    if event_id:
        return process_event(event_id)

    with connect() as conn:
        rows = conn.execute("""
            SELECT e.id, e.first_reported_at
            FROM news_events e
            JOIN news_event_sources es ON es.event_id = e.id
            JOIN news_articles a ON a.id = es.article_id
            WHERE e.status = 'active'
              AND a.hidden_at IS NULL
              AND a.status = 'extracted'
              AND LENGTH(a.body) > 200
              AND e.first_reported_at > NOW() - INTERVAL '48 hours'
            GROUP BY e.id, e.first_reported_at
            HAVING COUNT(DISTINCT es.article_id) >= 2
            ORDER BY e.first_reported_at DESC
            LIMIT %s
        """, (limit,)).fetchall()

    event_ids = [r["id"] for r in rows]
    log.info("syndication_detector: processing %d events", len(event_ids))

    totals = {"events": len(event_ids), "originals": 0, "copies": 0, "errors": 0}
    for eid in event_ids:
        try:
            stats = process_event(eid)
            totals["originals"] += stats["originals"]
            totals["copies"] += stats["copies"]
        except Exception as ex:
            log.warning("Error processing event %d: %s", eid, ex)
            totals["errors"] += 1

    log.info(
        "syndication_detector: done — %d events, %d originals, %d copies",
        totals["events"], totals["originals"], totals["copies"]
    )
    return totals


if __name__ == "__main__":
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(description="Syndication detector")
    parser.add_argument("--event-id", type=int, help="Process specific event")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        log.info("Dry run — no DB writes")
        sys.exit(0)

    result = run(event_id=args.event_id, limit=args.limit)
    print(__import__("json").dumps(result))
