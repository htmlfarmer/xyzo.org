"""Article Priority Scorer — decides which articles deserve AI treatment.

Given a daily budget of ~4,800 AI-capable articles (50% CPU, 100 tok/s,
~700 words/article), we need to select the most valuable ~34% of the ~14,000
daily articles for full AI extraction. The rest get lightweight regex-based
extraction.

Scoring factors (weighted):
─────────────────────────
1. Source quality (0.12)      — reliability_score, active status
2. Event novelty (0.18)       — is this event_type under-represented today?
3. Geographic uniqueness (0.18) — is this location rare/under-covered?
4. Temporal freshness (0.12)  — how recent is the article?
5. Entity novelty (0.12)      — are entities new or already seen today?
6. Topic diversity (0.13)     — does this add new topic coverage?
7. Content quality (0.15)     — author attribution, contact info, readability

Score range: 0.0 (skip AI) to 1.0 (highest priority)

Usage:
    from worker.article_priority import score_article, select_top_articles
    score = score_article(article_row, context)
    top = select_top_articles(articles, budget=4800)
"""
from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("xyzo.priority")

# ── Scoring weights ──────────────────────────────────────────────────────────
WEIGHTS = {
    "source_quality":    0.12,
    "event_novelty":     0.18,
    "geo_uniqueness":    0.18,
    "temporal_freshness": 0.12,
    "entity_novelty":    0.12,
    "topic_diversity":   0.13,
    "content_quality":   0.15,
}


class CycleContext:
    """Accumulates statistics across a fetch cycle for relative scoring."""

    def __init__(self):
        self.event_type_counts: Counter = Counter()
        self.country_counts: Counter = Counter()
        self.entity_counts: Counter = Counter()
        self.topic_counts: Counter = Counter()
        self.total_articles = 0
        self.avg_reliability = 0.5

    def update(self, article: dict) -> None:
        self.total_articles += 1
        et = (article.get("event_type") or "other").lower()
        self.event_type_counts[et] += 1
        cc = (article.get("source_country") or "unknown").upper()
        self.country_counts[cc] += 1
        for e in article.get("entities") or []:
            if e and isinstance(e, str):
                self.entity_counts[e.lower()] += 1
        for t in article.get("topic_tags") or []:
            if t and isinstance(t, str):
                self.topic_counts[t.lower()] += 1

    def finalize(self) -> None:
        if self.total_articles > 0:
            self.avg_reliability = sum(
                self.event_type_counts.values()
            ) / max(self.total_articles, 1)


def score_source_quality(article: dict) -> float:
    """Score based on source reliability (0-1)."""
    reliability = article.get("reliability_score") or article.get("credibility_score")
    if reliability is None:
        return 0.5  # unknown source = neutral
    return min(1.0, max(0.0, float(reliability)))


def score_event_novelty(article: dict, ctx: CycleContext) -> float:
    """Score based on how rare this event_type is today.

    Common event types (politics, business) get lower scores;
    rare types (disaster, conflict, science) get higher scores.
    """
    et = (article.get("event_type") or "other").lower()
    count = ctx.event_type_counts.get(et, 0)
    total = max(ctx.total_articles, 1)
    pct = count / total

    # Inverse frequency: rare types score higher
    # pct=0.01 → score≈0.95, pct=0.30 → score≈0.15
    novelty = max(0.0, 1.0 - (pct * 3.0))

    # Bonus for inherently high-value event types
    HIGH_VALUE = {"disaster", "conflict", "science", "health", "environment", "humanitarian"}
    if et in HIGH_VALUE:
        novelty = min(1.0, novelty + 0.15)

    return novelty


def score_geo_uniqueness(article: dict, ctx: CycleContext) -> float:
    """Score based on geographic uniqueness.

    Articles from under-covered countries score higher.
    """
    cc = (article.get("source_country") or "unknown").upper()
    count = ctx.country_counts.get(cc, 0)
    total = max(ctx.total_articles, 1)
    pct = count / total

    # Inverse frequency: rare countries score higher
    # Also consider if the article has a specific location
    has_location = bool(article.get("location_text") or article.get("auto_categorize_city_id"))
    location_bonus = 0.1 if has_location else 0.0

    # Under-covered regions get a boost
    UNDER_COVERED = {"AF", "MM", "YE", "SY", "SD", "ET", "CD", "SO", "LY", "SS", "ER"}
    region_bonus = 0.2 if cc in UNDER_COVERED else 0.0

    novelty = max(0.0, 1.0 - (pct * 5.0))
    return min(1.0, novelty + location_bonus + region_bonus)


def score_temporal_freshness(article: dict) -> float:
    """Score based on how recent the article is.

    Articles from the last hour score highest; older articles decay.
    """
    published = article.get("published_at") or article.get("fetched_at")
    if published is None:
        return 0.5

    if isinstance(published, str):
        try:
            published = datetime.fromisoformat(published.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return 0.5

    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    age_hours = max(0, (now - published).total_seconds() / 3600)

    # Exponential decay: fresh articles score highest
    # age=0h → 1.0, age=6h → 0.74, age=24h → 0.37, age=72h → 0.05
    return math.exp(-0.05 * age_hours)


def score_entity_novelty(article: dict, ctx: CycleContext) -> float:
    """Score based on how novel the entities are.

    Articles with entities not yet seen today score higher.
    """
    entities = article.get("entities") or []
    if not entities:
        return 0.3  # no entities = neutral-low

    novel_count = 0
    for e in entities:
        if e and isinstance(e, str):
            if ctx.entity_counts.get(e.lower(), 0) <= 1:
                novel_count += 1

    ratio = novel_count / max(len(entities), 1)
    return min(1.0, ratio + 0.1)  # small bonus for having entities at all


def score_topic_diversity(article: dict, ctx: CycleContext) -> float:
    """Score based on topic novelty.

    Articles covering topics not yet seen today score higher.
    """
    topics = article.get("topic_tags") or []
    if not topics:
        return 0.3  # no topics = neutral-low

    novel_count = 0
    for t in topics:
        if t and isinstance(t, str):
            if ctx.topic_counts.get(t.lower(), 0) <= 1:
                novel_count += 1

    ratio = novel_count / max(len(topics), 1)
    return min(1.0, ratio + 0.1)


# ── Content quality signals ─────────────────────────────────────────────────
# Heuristic patterns for byline / contact / readability detection.
_RE_BYLINE = re.compile(
    r"(?:^|\n)\s*(?:by\s+|written\s+by\s+|author:\s+|reporter:\s+|"
    r"correspondent:\s+|staff\s+writer\s+|contributor:\s+)",
    re.IGNORECASE,
)
_RE_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_RE_PHONE = re.compile(r"(?:\+?\d{1,4}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}")
_RE_SOCIAL = re.compile(
    r"(?:@\w{2,20}|"
    r"(?:twitter|x|instagram|facebook|linkedin|threads)\s*[:/]?\s*\S+)",
    re.IGNORECASE,
)
_RE_QUESTIONS = re.compile(r"\?")
_RE_PERSON = re.compile(
    r"(?:\bi\b|\bwe\b|\byou\b|\byour\b|\bus\b|\bour\b)", re.IGNORECASE
)
_RE_LIST = re.compile(r"(?:^|\n)\s*[-*•]\s+|(?:^|\n)\s*\d+[.)]\s+", re.MULTILINE)
_RE_POSITIVE = re.compile(
    r"\b(?:great|good|helpful|useful|important|inspiring|amazing|"
    r"innovative| breakthrough|solution|opportunity|progress|success|"
    r"celebrate|joy|hope|resilient|community|together|positive)\b",
    re.IGNORECASE,
)
_RE_JUNK = re.compile(
    r"(?:click\s+here|subscribe\s+now|sign\s+up|limited\s+time|"
    r"act\s+now|don'?t\s+miss|exclusive\s+offer|sponsored\s+content)",
    re.IGNORECASE,
)


def score_content_quality(article: dict) -> float:
    """Score based on author attribution, contact info, and readability.

    Rewards articles that:
      - Have a named author / byline
      - Include contact info (email, phone, social)
      - Use conversational / friendly tone
      - Are well-structured and readable
      - Avoid spammy / clickbait language
    """
    title = article.get("title") or ""
    body = article.get("body") or ""
    summary = article.get("summary") or ""
    text = f"{title}\n{summary}\n{body}"

    score = 0.2  # neutral base

    # ── Author attribution (+0.25) ──────────────────────────────────────
    if _RE_BYLINE.search(text[:1500]):
        score += 0.25
    elif any(w in text[:800].lower() for w in ("by ", "written by", "author:")):
        score += 0.15

    # ── Contact info (+0.15) ────────────────────────────────────────────
    has_email = bool(_RE_EMAIL.search(body))
    has_phone = bool(_RE_PHONE.search(body))
    has_social = bool(_RE_SOCIAL.search(body))
    contact_count = sum([has_email, has_phone, has_social])
    score += min(0.15, contact_count * 0.07)

    # ── Readability / friendliness (+0.2 max) ───────────────────────────
    words = text.split()
    word_count = len(words)
    if word_count > 20:
        sentences = max(1, text.count(".") + text.count("!") + text.count("?"))
        avg_words_per_sent = word_count / sentences

        # Shorter sentences = more readable (20 wps → 1.0, 40+ wps → 0.0)
        read_score = max(0.0, 1.0 - (avg_words_per_sent - 15) / 25)
        score += read_score * 0.10

        # Conversational tone: 1st/2nd person pronouns
        person_hits = len(_RE_PERSON.findall(text))
        person_ratio = min(1.0, person_hits / max(word_count / 50, 1))
        score += person_ratio * 0.05

        # Questions = engagement signal
        q_count = len(_RE_QUESTIONS.findall(text))
        if 1 <= q_count <= 8:
            score += 0.03
        elif q_count > 8:
            score += 0.01  # too many questions = filler

    # ── Structure (+0.05) ───────────────────────────────────────────────
    list_hits = len(_RE_LIST.findall(body))
    if list_hits >= 3:
        score += 0.05  # well-structured, scannable content
    elif list_hits >= 1:
        score += 0.02

    # ── Positive / helpful language (+0.05) ─────────────────────────────
    positive_hits = len(_RE_POSITIVE.findall(text))
    if positive_hits >= 2:
        score += 0.05
    elif positive_hits >= 1:
        score += 0.02

    # ── Spam penalty (-0.15) ────────────────────────────────────────────
    junk_hits = len(_RE_JUNK.findall(text))
    if junk_hits >= 3:
        score -= 0.15
    elif junk_hits >= 1:
        score -= 0.05

    return max(0.0, min(1.0, score))


def score_article(article: dict, ctx: CycleContext) -> float:
    """Compute composite priority score for an article.

    Returns a float in [0, 1] where higher = more valuable for AI treatment.
    """
    scores = {
        "source_quality":    score_source_quality(article),
        "event_novelty":     score_event_novelty(article, ctx),
        "geo_uniqueness":    score_geo_uniqueness(article, ctx),
        "temporal_freshness": score_temporal_freshness(article),
        "entity_novelty":    score_entity_novelty(article, ctx),
        "topic_diversity":   score_topic_diversity(article, ctx),
        "content_quality":   score_content_quality(article),
    }

    composite = sum(
        scores[k] * WEIGHTS[k] for k in WEIGHTS
    )

    return round(min(1.0, max(0.0, composite)), 4)


def select_top_articles(
    articles: list[dict],
    budget: int = 4800,
    min_score: float = 0.3,
) -> tuple[list[dict], list[dict]]:
    """Select the top N articles for AI treatment.

    Returns (ai_articles, skip_articles) split.
    Articles below min_score always go to skip.
    """
    if not articles:
        return [], []

    # Build cycle context from all articles
    ctx = CycleContext()
    for art in articles:
        ctx.update(art)
    ctx.finalize()

    # Score all articles
    scored = []
    for art in articles:
        s = score_article(art, ctx)
        scored.append((s, art))

    # Sort by score descending
    scored.sort(key=lambda x: x[0], reverse=True)

    # Split at budget or min_score threshold
    ai_articles = []
    skip_articles = []

    for score, art in scored:
        if len(ai_articles) < budget and score >= min_score:
            art["_priority_score"] = score
            ai_articles.append(art)
        else:
            art["_priority_score"] = score
            skip_articles.append(art)

    log.info(
        "priority: selected %d/%d articles for AI (budget=%d, min_score=%.2f, "
        "top_score=%.3f, median_score=%.3f)",
        len(ai_articles), len(articles), budget, min_score,
        ai_articles[0]["_priority_score"] if ai_articles else 0,
        scored[len(scored) // 2][0] if scored else 0,
    )

    return ai_articles, skip_articles


def get_priority_stats(articles: list[dict]) -> dict:
    """Return statistics about priority scores for monitoring."""
    if not articles:
        return {"count": 0}

    ctx = CycleContext()
    for art in articles:
        ctx.update(art)
    ctx.finalize()

    scores = [score_article(art, ctx) for art in articles]
    scores.sort()

    # Per-factor breakdown for monitoring
    cq_scores = [score_content_quality(art) for art in articles]
    cq_scores.sort()

    return {
        "count": len(scores),
        "min": round(scores[0], 3),
        "p25": round(scores[len(scores) // 4], 3),
        "median": round(scores[len(scores) // 2], 3),
        "p75": round(scores[3 * len(scores) // 4], 3),
        "max": round(scores[-1], 3),
        "mean": round(sum(scores) / len(scores), 3),
        "above_0.3": sum(1 for s in scores if s >= 0.3),
        "above_0.5": sum(1 for s in scores if s >= 0.5),
        "above_0.7": sum(1 for s in scores if s >= 0.7),
        "event_types": dict(ctx.event_type_counts.most_common(10)),
        "countries": dict(ctx.country_counts.most_common(10)),
        "content_quality_median": round(cq_scores[len(cq_scores) // 2], 3),
        "content_quality_p75": round(cq_scores[3 * len(cq_scores) // 4], 3),
    }
