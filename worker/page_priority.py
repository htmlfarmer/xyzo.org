"""page_priority — score URLs so the crawler visits event-rich paths first.

The crawler fetches up to N pages from a host. The order matters:
fetching /events before /about-team means we discover events first and
can stop early if the page is rich enough. This module is the scoring
function that ranks the BFS frontier.

Score components (each 0..1, summed with weights):

  • Path keyword matches:
      +1.0 for /events, /calendar, /schedule, /agenda, /program,
            /whats-on, /lineup, /festivals, /line-up
      +0.6 for /concerts, /shows, /performances, /lectures,
            /workshops, /seminars, /meetups, /conferences
      +0.4 for /news, /blog, /stories, /articles (sometimes carry
            event announcements)
      -1.0 for /privacy, /terms, /login, /signup, /cart, /checkout,
            /admin, /wp-admin, /cdn-cgi

  • URL shape:
      +0.2 for shorter paths
      -0.1 per "deep" path segment (>4 segments)

  • Host allowance:
      always 1.0 if robots allows; 0 if robots disallows (caller
      filters disallowed URLs before scoring).

Returns a float in roughly [-1, 1.2].
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlparse

# ── Signal tables ────────────────────────────────────────────────────
_HIGH_PRIORITY_PATTERNS: list[re.Pattern] = [
    re.compile(r"/events?(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/calendar(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/schedule", re.IGNORECASE),
    re.compile(r"/agenda", re.IGNORECASE),
    re.compile(r"/program(?:me)?s?", re.IGNORECASE),
    re.compile(r"/whats-?on", re.IGNORECASE),
    re.compile(r"/line-?up", re.IGNORECASE),
    re.compile(r"/lineup", re.IGNORECASE),
    re.compile(r"/festivals?", re.IGNORECASE),
    re.compile(r"/exhibitions?", re.IGNORECASE),
    re.compile(r"/upcoming", re.IGNORECASE),
]

_MEDIUM_PRIORITY_PATTERNS: list[re.Pattern] = [
    re.compile(r"/concerts?", re.IGNORECASE),
    re.compile(r"/shows?", re.IGNORECASE),
    re.compile(r"/performances?", re.IGNORECASE),
    re.compile(r"/lectures?", re.IGNORECASE),
    re.compile(r"/workshops?", re.IGNORECASE),
    re.compile(r"/seminars?", re.IGNORECASE),
    re.compile(r"/meetups?", re.IGNORECASE),
    re.compile(r"/conferences?", re.IGNORECASE),
    re.compile(r"/tournaments?", re.IGNORECASE),
    re.compile(r"/races?", re.IGNORECASE),
    re.compile(r"/games?(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/matches?", re.IGNORECASE),
    re.compile(r"/tour(?:s)?(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/listings?", re.IGNORECASE),
    re.compile(r"/venues?", re.IGNORECASE),
    re.compile(r"/categories?/", re.IGNORECASE),
    re.compile(r"/tags?/", re.IGNORECASE),
]

_LOW_PRIORITY_PATTERNS: list[re.Pattern] = [
    re.compile(r"/news(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/blog(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/stories?", re.IGNORECASE),
    re.compile(r"/articles?", re.IGNORECASE),
    re.compile(r"/press", re.IGNORECASE),
    re.compile(r"/media", re.IGNORECASE),
]

_DEPRIORITIZE_PATTERNS: list[re.Pattern] = [
    re.compile(r"/privacy", re.IGNORECASE),
    re.compile(r"/terms", re.IGNORECASE),
    re.compile(r"/tos", re.IGNORECASE),
    re.compile(r"/login", re.IGNORECASE),
    re.compile(r"/signup", re.IGNORECASE),
    re.compile(r"/signin", re.IGNORECASE),
    re.compile(r"/register", re.IGNORECASE),
    re.compile(r"/checkout", re.IGNORECASE),
    re.compile(r"/cart", re.IGNORECASE),
    re.compile(r"/account", re.IGNORECASE),
    re.compile(r"/admin", re.IGNORECASE),
    re.compile(r"/wp-admin", re.IGNORECASE),
    re.compile(r"/cdn-cgi", re.IGNORECASE),
    re.compile(r"/cdn-cgi/", re.IGNORECASE),
    re.compile(r"/search", re.IGNORECASE),
    re.compile(r"/contact", re.IGNORECASE),
    re.compile(r"/about(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/help(?:[-_/]|$)", re.IGNORECASE),
    re.compile(r"/faq", re.IGNORECASE),
    re.compile(r"/careers?", re.IGNORECASE),
    re.compile(r"/jobs?", re.IGNORECASE),
    re.compile(r"/legal", re.IGNORECASE),
    re.compile(r"/sitemap", re.IGNORECASE),
]

# File extensions we never want to fetch
_NON_HTML_EXTENSIONS: set[str] = {
    ".pdf", ".zip", ".tar", ".gz", ".rar", ".7z",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".ogg",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".css", ".js", ".mjs", ".json", ".xml", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
}


@dataclass
class ScoredURL:
    url: str
    score: float
    reasons: list[str]

    def __lt__(self, other: "ScoredURL") -> bool:
        return self.score > other.score  # descending


def is_html_worthy(url: str) -> bool:
    """Return True if the URL points to something we might want to crawl."""
    parsed = urlparse(url)
    path = parsed.path.lower()
    # Skip files with non-HTML extensions
    for ext in _NON_HTML_EXTENSIONS:
        if path.endswith(ext):
            return False
    # Skip mailto / tel / javascript
    if parsed.scheme not in ("http", "https", ""):
        return False
    return True


def score_url(url: str) -> ScoredURL:
    """Score a URL. Higher = more likely to surface events."""
    parsed = urlparse(url)
    path = parsed.path or "/"
    score = 0.0
    reasons: list[str] = []

    for rgx in _HIGH_PRIORITY_PATTERNS:
        if rgx.search(path):
            score += 1.0
            reasons.append(f"high:{rgx.pattern}")
            break  # only one boost per tier
    for rgx in _MEDIUM_PRIORITY_PATTERNS:
        if rgx.search(path):
            score += 0.6
            reasons.append(f"med:{rgx.pattern}")
            break
    for rgx in _LOW_PRIORITY_PATTERNS:
        if rgx.search(path):
            score += 0.4
            reasons.append(f"low:{rgx.pattern}")
            break
    for rgx in _DEPRIORITIZE_PATTERNS:
        if rgx.search(path):
            score -= 1.0
            reasons.append(f"dep:{rgx.pattern}")
            break

    # Shorter paths get a small boost; deeper paths get a small penalty
    segments = [s for s in path.split("/") if s]
    if len(segments) <= 2:
        score += 0.2
        reasons.append("path:short")
    elif len(segments) > 4:
        score -= 0.1 * (len(segments) - 4)
        reasons.append("path:deep")

    # The homepage itself is neutral; it's the seed.
    if path in ("", "/"):
        score = 0.5  # explicit base
        reasons.append("home")

    return ScoredURL(url=url, score=score, reasons=reasons)


def rank_urls(urls: Iterable[str], cap: int = 200
              ) -> list[ScoredURL]:
    """Score and sort URLs in priority order, dropping non-HTML."""
    seen: set[str] = set()
    out: list[ScoredURL] = []
    for url in urls:
        # Normalise: drop fragment, trailing slash (except root)
        parsed = urlparse(url)
        clean = f"{parsed.scheme or 'https'}://{parsed.netloc}{parsed.path}"
        if parsed.query:
            clean += "?" + parsed.query
        if clean.endswith("/") and len(parsed.path) > 1:
            clean = clean[:-1]
        if clean in seen:
            continue
        seen.add(clean)
        if not is_html_worthy(clean):
            continue
        out.append(score_url(clean))
    out.sort()
    return out[:cap]


def score_url_with_intelligence(
    url: str,
    intelligence: dict | None,
    hints: "CrawlHints | None" = None,
    classifier_score: float | None = None,
    classifier_weight: float | None = None,
    page_priority_weight: float | None = None,
    intelligence_weight: float | None = None,
) -> float:
    """Blend page_priority + (optional classifier) + intelligence hint.

    The blend is deliberately *not* a flat weighted sum of all three terms,
    because the three inputs are not the same kind of quantity:

      • ``page_priority`` and ``classifier_score`` are both *absolute* scores
        on page_priority's scale (roughly -1.0 .. 1.2). They are combined as
        a **normalised weighted mean** — the weights are divided by their own
        sum, so the result stays on that same scale no matter how the weights
        are tuned, and no matter whether a classifier score was supplied.

      • ``intelligence`` contributes an *additive adjustment* (see
        ``intelligence_consume.url_adjustment``), not a score. It is added on
        top, scaled by ``intelligence_weight``.

    Two properties fall out of that shape, both of which matter:

      1. With no classifier and no intelligence, the result is exactly
         ``score_url(url).score``. A flat weighted sum would instead return
         ``0.7 * pp`` (the intelligence weight multiplying a 0.0 adjustment),
         which silently deflates URLs that have no intelligence and makes
         them incomparable to URLs that do — corrupting frontier ranking.

      2. Avoidance does not double-count. ``/admin`` is penalised by
         page_priority (-1.0) *and* flagged by intelligence (-2.0). Scaling
         the hint by ``intelligence_weight`` keeps the total near -1.4
         instead of stacking to -2.8, so the URL is deprioritised without
         being driven into a dead zone it can never climb out of.

    ``classifier_score`` is expected on page_priority's scale, not as a raw
    0..1 probability; a probability should be rescaled by the caller before
    being passed in, or it will never outrank a strong keyword match.

    Weights default to feature_config values; passing them explicitly makes
    the function easy to test without DB access. Each weight is resolved
    independently, so overriding one does not leave the others unset.
    """
    from worker.intelligence_consume import url_adjustment

    pp_score = score_url(url).score

    # Defaults pulled lazily so unit tests without DB still work. get_config
    # degrades to its own default if the DB is unreachable, and each weight is
    # resolved on its own so callers can override just one.
    if classifier_weight is None or page_priority_weight is None \
            or intelligence_weight is None:
        defaults = _blend_weight_defaults()
        if classifier_weight is None:
            classifier_weight = defaults[0]
        if page_priority_weight is None:
            page_priority_weight = defaults[1]
        if intelligence_weight is None:
            intelligence_weight = defaults[2]

    if hints is None and intelligence is not None:
        from worker.intelligence_consume import parse_intelligence_to_hints
        hints = parse_intelligence_to_hints(intelligence)
    intel_adj = url_adjustment(url, hints) if hints is not None else 0.0

    # Absent a classifier, page_priority stands in for it, so the mean below
    # collapses cleanly to pp_score rather than half-counting it.
    effective_classifier = (
        classifier_score if classifier_score is not None else pp_score
    )

    score_weight = classifier_weight + page_priority_weight
    if score_weight <= 0:
        # Degenerate weighting — fall back to raw page_priority rather than
        # dividing by zero.
        blended = pp_score
    else:
        blended = (
            classifier_weight * effective_classifier +
            page_priority_weight * pp_score
        ) / score_weight

    return blended + intelligence_weight * intel_adj


def _blend_weight_defaults() -> tuple[float, float, float]:
    """Return (classifier, page_priority, intelligence) weights from config."""
    try:
        from api.src.xyzo_features import get_config
        return (
            float(get_config("classifier.weight", "0.4")),
            float(get_config("page_priority.weight", "0.3")),
            float(get_config("intelligence_hint.weight", "0.3")),
        )
    except Exception:
        return (0.4, 0.3, 0.3)
