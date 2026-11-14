"""Document Type Classifier — classifies news articles into structural genres.

Supported document types:
  - news_report        : Straight news reporting / breaking news / event coverage
  - opinion_editorial  : Op-ed, commentary, opinion column, editorial
  - analysis_explainer : Deep dive, policy analysis, explainer, guide, backgrounder
  - interview          : Q&A interview, conversation transcript
  - press_release      : Official statement, government release, corporate announcement
  - sports_recap       : Match summary, game score report, sports recap
  - review             : Product review, film/book/tech review, rating
  - listicle_digest    : Roundup, newsletter digest, top 10 list, summary list
  - live_blog          : Minute-by-minute updates, live blog, rolling coverage

Usage:
    from worker.doc_type import classify_doc_type
    doc_type, confidence = classify_doc_type(title, body)
"""
from __future__ import annotations

import re

# Rule-based heuristics for fast, deterministic document classification
DOC_TYPE_PATTERNS: list[tuple[str, list[str], float]] = [
    # ── Live Blog / Rolling Coverage ────────────────────────────────
    ("live_blog", [
        r"\blive\s+updates\b", r"\blive\s+blog\b", r"\brolling\s+coverage\b",
        r"\bminute-by-minute\b", r"\blive\s+coverage\b", r"\bas\s+it\s+happened\b",
        r"^live:", r"^live\s+-\s+", r"\[live\]"
    ], 0.95),

    # ── Opinion / Editorial ─────────────────────────────────────────
    ("opinion_editorial", [
        r"^op-ed:", r"^opinion:", r"^editorial:", r"^commentary:",
        r"\bopinion\b", r"\bop-ed\b", r"\beditorial\b", r"\bviewpoint\b",
        r"\bcolumnist\b", r"\bmy\s+turn\b", r"\bperspective:\b",
        r"\bwhy\s+i\s+believe\b", r"\bwhy\s+we\s+must\b", r"\bin\s+my\s+view\b"
    ], 0.90),

    # ── Interview / Q&A ─────────────────────────────────────────────
    ("interview", [
        r"^q&a:", r"^interview:", r"\binterview\s+with\b", r"\bin\s+conversation\b",
        r"\bq&a\s+with\b", r"\bfull\s+transcript\b", r"\btranscript:\b",
        r"\bq:\s+.*?\na:\s+", r"\bquestions\s+and\s+answers\b"
    ], 0.92),

    # ── Review ──────────────────────────────────────────────────────
    ("review", [
        r"^review:", r"\breview:\b", r"\bfilm\s+review\b", r"\bmovie\s+review\b",
        r"\bbook\ review\b", r"\balbum\s+review\b", r"\bgame\s+review\b",
        r"\brating:\s*\d/\d\b", r"\b\d/\d\s+stars\b", r"\bhands-on\s+review\b"
    ], 0.90),

    # ── Analysis / Explainer ────────────────────────────────────────
    ("analysis_explainer", [
        r"^analysis:", r"^explainer:", r"^deep\s+dive:", r"\banalysis\b",
        r"\bexplainer\b", r"\bwhat\s+you\s+need\t+to\s+know\b", r"\bhere['’]s\s+why\b",
        r"\bhow\s+it\s+works\b", r"\bthe\s+facts\s+behind\b", r"\bbackgrounder\b",
        r"\beverything\s+to\s+know\b"
    ], 0.85),

    # ── Press Release / Official Announcement ───────────────────────
    ("press_release", [
        r"^press\s+release:", r"\bpress\s+release\b", r"\bfor\s+immediate\s+release\b",
        r"\bmedia\s+advisory\b", r"\bofficial\s+statement\b", r"\bannounced\s+today\s+that\b",
        r"\bheadquartered\s+in\b", r"\bis\s+pleased\s+to\s+announce\b"
    ], 0.88),

    # ── Sports Recap ────────────────────────────────────────────────
    ("sports_recap", [
        r"\bdefeats\s+.*?\s+\d+-\d+\b", r"\bbeats\s+.*?\s+\d+-\d+\b",
        r"\bwins\s+.*?\s+\d+-\d+\b", r"\bgame\s+recap\b", r"\bmatch\s+report\b",
        r"\bfinal\s+score\b", r"\bhalftime\s+lead\b", r"\bhighlight\s+reel\b"
    ], 0.90),

    # ── Listicle / Digest ───────────────────────────────────────────
    ("listicle_digest", [
        r"\broundup\b", r"\bweekly\s+digest\b", r"\bnewsletter\b",
        r"\b\d+\s+things\s+to\s+know\b", r"\btop\s+\d+\b", r"\bbest\s+\d+\b",
        r"\bdaily\s+briefing\b", r"\bmorning\s+report\b", r"\bnews\s+summary\b"
    ], 0.85),
]


def classify_doc_type(title: str, body: str = "") -> tuple[str, float]:
    """Classify the structural type/genre of a document.

    Args:
        title: Article title
        body: Article body text

    Returns:
        (doc_type, confidence) e.g. ("opinion_editorial", 0.90)
    """
    text = f"{title or ''}\n{body or ''}".strip()
    text_lower = text.lower()

    # Title patterns carry higher weight
    title_lower = (title or "").lower()

    for doc_type, patterns, confidence in DOC_TYPE_PATTERNS:
        for pat in patterns:
            # Check title first
            if re.search(pat, title_lower):
                return doc_type, confidence
            # Check early body (first 500 chars)
            if re.search(pat, text_lower[:500]):
                return doc_type, round(confidence * 0.9, 2)

    # Default fallback: straight news report
    return "news_report", 0.70
