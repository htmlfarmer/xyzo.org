"""Image candidate scorer — picks the best article image without downloading.

Uses a weighted-feature approach (single-layer perceptron style) to score
image candidates based on signals extractable from HTML alone:

  - URL features: dimensions in path, CDN hints, file extension quality
  - Position features: where the <img> appears in the document
  - Context features: parent element semantics (figure, article, hero div)
  - Metadata features: width/height attributes, alt text quality
  - Meta-tag trust: og:image / twitter:image get highest base score

No network requests are made — all scoring is from parsed HTML attributes.

Usage:
    from .image_scorer import score_candidates, pick_best_image
    candidates = extract_image_candidates(html, base_url)
    best = pick_best_image(candidates)
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse


@dataclass
class ImageCandidate:
    url: str
    score: float = 0.0
    source: str = ""          # "og", "twitter", "img_tag", "enclosure", "media_content"
    position: int = 0         # ordinal position in document (0 = first)
    width: int | None = None
    height: int | None = None
    alt: str = ""
    context: str = ""         # parent element class/id hint
    features: dict = field(default_factory=dict)


# ── Feature weights (perceptron-style) ────────────────────────────────
# Positive = boosts score, negative = penalises.  Tuned from observing
# news-site image patterns; no training data needed.
W_SOURCE_OG        = 30.0   # og:image meta tag — most reliable
W_SOURCE_TWITTER   = 25.0   # twitter:image — almost as good
W_SOURCE_MEDIA     = 20.0   # media:content with medium="image"
W_SOURCE_ENCL      = 12.0   # RSS enclosure
W_SOURCE_IMG_TAG   = 8.0    # raw <img> in HTML

W_POS_FIRST        = 15.0   # first image in article body
W_POS_EARLY        = 8.0    # within first 3 images
W_POS_LATE         = -5.0   # after 10th image — likely decorative

W_CTX_FIGURE       = 12.0   # inside <figure>
W_CTX_ARTICLE      = 6.0    # inside <article>
W_CTX_HERO         = 18.0   # parent has "hero"/"featured"/"banner" class
W_CTX_SIDEBAR      = -10.0  # inside sidebar/nav/footer
W_CTX_AD           = -20.0  # near ad-related elements

W_DIM_LARGE        = 10.0   # width >= 600 or height >= 400
W_DIM_MEDIUM       = 4.0    # width >= 300
W_DIM_TINY         = -15.0  # width < 50 (icon / tracker)
W_DIM_ASPECT_OK    = 3.0    # aspect ratio between 0.4 and 2.5 (not panoramic/square-tiny)

W_URL_HERO_HINT    = 8.0    # URL contains hero/featured/large/cover
W_URL_DIM_NUM      = 5.0    # URL contains dimension like /1200x800/
W_URL_TRACKER      = -25.0  # URL matches tracker/pixel patterns
W_URL_SVG          = -30.0  # SVG file — not a photo
W_URL_SOCIAL       = -15.0  # social sharing / feedburner / tracking

W_ALT_DESCRIPTIVE  = 4.0    # alt text > 10 chars (real caption)
W_ALT_EMPTY        = -2.0   # empty alt — not necessarily bad, slight penalty
W_ALT_LOGO         = -12.0  # alt contains "logo" / "icon"

# ── Noise patterns (URLs that are never article images) ───────────────
NOISE_URL_PATTERNS = re.compile(
    r"pixel|track|gravatar\.com|favicon|apple-touch-icon|/icon|logo\.|"
    r"badge|avatar|blank\.gif|1x1|spacer|share\.png|facebook\.png|"
    r"twitter\.png|pinterest\.png|feedburner|1pixel|beacon|analytics|"
    r"transparent\.gif|empty\.gif|clear\.gif",
    re.I,
)

HERO_URL_HINTS = re.compile(
    r"hero|featured|banner|header|cover|large|main|lead|top-?story|"
    r"og-image|social-image|thumbnail-large|_1200|_800|_1024",
    re.I,
)

DIM_IN_URL = re.compile(r"(\d{3,4})\s*[xX×]\s*(\d{3,4})")

SIDEBAR_CTX = re.compile(
    r"sidebar|widget|footer|nav|menu|comment|related|recommend|"
    r"advert|sponsor|promo|newsletter|subscribe",
    re.I,
)

HERO_CTX = re.compile(
    r"hero|featured|banner|header|lead|main-image|top-story|"
    r"article-image|story-image|entry-image|post-image",
    re.I,
)

BAD_ALT = re.compile(r"logo|icon|avatar|badge|pixel|tracker|spacer|blank", re.I)


def _normalise_url(raw: str, base: str = "") -> str | None:
    """Resolve and validate an image URL."""
    if not raw or not isinstance(raw, str):
        return None
    # UNESCAPE THE HTML ENTITIES. A URL lifted out of an HTML attribute
    # still carries its entities: src="…?format=jpg&amp;name=large" is
    # stored as "…?format=jpg&amp;name=large", and the upstream server
    # answers 404 for it. Twitter's image host is the worst case —
    # 204 of its 205 rows were broken this way. worker/video_discover.py
    # already unescapes; this was the same bug in a different module.
    u = html.unescape(raw.strip())
    if not u:
        return None
    low = u.lower()
    # Skip non-image extensions
    if low.endswith((".mp4", ".avi", ".mov", ".mp3", ".pdf", ".xml", ".json", ".webp")):
        # webp is actually valid but often used for tracking — keep it only if large
        if low.endswith(".webp"):
            pass  # allow webp
        else:
            return None
    if NOISE_URL_PATTERNS.search(u):
        return None
    # Resolve relative URLs
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("/"):
        return urljoin(base, u) if base else None
    if u.startswith("http://") or u.startswith("https://"):
        return u
    if base:
        return urljoin(base, u)
    return None


def _extract_dims_from_url(url: str) -> tuple[int | None, int | None]:
    """Try to extract width x height from URL path segments."""
    m = DIM_IN_URL.search(url)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


def _score_source(source: str) -> float:
    return {
        "og": W_SOURCE_OG,
        "twitter": W_SOURCE_TWITTER,
        "media_content": W_SOURCE_MEDIA,
        "enclosure": W_SOURCE_ENCL,
        "img_tag": W_SOURCE_IMG_TAG,
    }.get(source, 0.0)


def _score_position(pos: int) -> float:
    if pos == 0:
        return W_POS_FIRST
    if pos < 3:
        return W_POS_EARLY
    if pos > 10:
        return W_POS_LATE
    return 0.0


def _score_context(ctx: str) -> float:
    s = 0.0
    if HERO_CTX.search(ctx):
        s += W_CTX_HERO
    elif "figure" in ctx.lower():
        s += W_CTX_FIGURE
    elif "article" in ctx.lower():
        s += W_CTX_ARTICLE
    if SIDEBAR_CTX.search(ctx):
        s += W_CTX_SIDEBAR
    return s


def _score_dimensions(w: int | None, h: int | None) -> float:
    s = 0.0
    width = w or 0
    height = h or 0
    if width >= 600 or height >= 400:
        s += W_DIM_LARGE
    elif width >= 300:
        s += W_DIM_MEDIUM
    if 0 < width < 50:
        s += W_DIM_TINY
    if width > 0 and height > 0:
        ratio = width / height
        if 0.4 <= ratio <= 2.5:
            s += W_DIM_ASPECT_OK
    return s


def _score_url(url: str) -> float:
    s = 0.0
    if HERO_URL_HINTS.search(url):
        s += W_URL_HERO_HINT
    if DIM_IN_URL.search(url):
        s += W_URL_DIM_NUM
    if url.lower().endswith(".svg"):
        s += W_URL_SVG
    if "feedburner" in url.lower() or "share" in url.lower():
        s += W_URL_SOCIAL
    return s


def _score_alt(alt: str) -> float:
    if not alt:
        return W_ALT_EMPTY
    if BAD_ALT.search(alt):
        return W_ALT_LOGO
    if len(alt) > 10:
        return W_ALT_DESCRIPTIVE
    return 0.0


def score_candidate(c: ImageCandidate) -> float:
    """Compute the total score for an image candidate."""
    total = 0.0
    total += _score_source(c.source)
    total += _score_position(c.position)
    total += _score_context(c.context)
    total += _score_dimensions(c.width, c.height)
    total += _score_url(c.url)
    total += _score_alt(c.alt)
    c.score = round(total, 2)
    return c.score


def score_candidates(candidates: list[ImageCandidate]) -> list[ImageCandidate]:
    """Score all candidates and return sorted best-first."""
    for c in candidates:
        score_candidate(c)
    candidates.sort(key=lambda c: c.score, reverse=True)
    return candidates


def pick_best_image(candidates: list[ImageCandidate], min_score: float = 5.0) -> str | None:
    """Return the URL of the best candidate, or None if none pass the threshold."""
    if not candidates:
        return None
    scored = score_candidates(candidates)
    best = scored[0]
    if best.score < min_score:
        return None
    return best.url


# ── HTML extraction helpers ───────────────────────────────────────────

def extract_meta_images(html: str, base_url: str) -> list[ImageCandidate]:
    """Extract og:image and twitter:image from <meta> tags."""
    results = []
    # og:image
    for pat in [
        r"""<meta[^>]+property=['"]og:image['"][^>]+content=['"]([^'"]+)['"]""",
        r"""<meta[^>]+content=['"]([^'"]+)['"][^>]+property=['"]og:image['"]""",
    ]:
        for m in re.findall(pat, html, re.I):
            url = _normalise_url(m, base_url)
            if url:
                results.append(ImageCandidate(url=url, source="og", position=0))

    # twitter:image
    for pat in [
        r"""<meta[^>]+(?:name|property)=['"]twitter:image['"][^>]+content=['"]([^'"]+)['"]""",
        r"""<meta[^>]+content=['"]([^'"]+)['"][^>]+name=['"]twitter:image['"]""",
    ]:
        for m in re.findall(pat, html, re.I):
            url = _normalise_url(m, base_url)
            if url:
                results.append(ImageCandidate(url=url, source="twitter", position=0))

    return results


def extract_body_images(html: str, base_url: str) -> list[ImageCandidate]:
    """Extract <img> tags from the article body with context scoring."""
    results = []
    # Find all <img> tags with their surrounding context
    img_pattern = re.compile(
        r'<(figure|div|article|aside|nav|section)[^>]*class=["\']([^"\']*)["\'][^>]*>'
        r'[^<]*(?:<(?:figure|div|article|aside|nav|section)[^>]*>[^<]*)*?'
        r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>',
        re.I | re.DOTALL,
    )
    # Simpler: just find all <img> tags and look at nearby context
    all_imgs = re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']([^>]*)>', html, re.I)
    pos = 0
    for m in all_imgs:
        raw_src = m.group(1)
        attrs = m.group(2)
        url = _normalise_url(raw_src, base_url)
        if not url:
            continue

        # Extract width/height from attributes
        w_m = re.search(r'(?:width|w)\s*=\s*["\']?(\d+)', attrs, re.I)
        h_m = re.search(r'(?:height|h)\s*=\s*["\']?(\d+)', attrs, re.I)
        width = int(w_m.group(1)) if w_m else None
        height = int(h_m.group(1)) if h_m else None

        # Try URL dimensions if HTML attrs missing
        if not width or not height:
            uw, uh = _extract_dims_from_url(url)
            width = width or uw
            height = height or uh

        # Alt text
        alt_m = re.search(r'alt\s*=\s*["\']([^"\']*)["\']', attrs, re.I)
        alt = alt_m.group(1) if alt_m else ""

        # Context: grab 200 chars before the <img> tag for context clues
        start = max(0, m.start() - 200)
        context_snippet = html[start:m.start()]

        cand = ImageCandidate(
            url=url,
            source="img_tag",
            position=pos,
            width=width,
            height=height,
            alt=alt,
            context=context_snippet,
        )
        results.append(cand)
        pos += 1

    return results


def extract_image_candidates(html: str, base_url: str) -> list[ImageCandidate]:
    """Extract all image candidates from an HTML page and score them.

    Combines meta-tag images (og/twitter) with body <img> tags,
    scores them all, and returns sorted best-first.
    """
    candidates = []
    candidates.extend(extract_meta_images(html, base_url))
    candidates.extend(extract_body_images(html, base_url))

    # Deduplicate by URL
    seen = set()
    unique = []
    for c in candidates:
        if c.url not in seen:
            seen.add(c.url)
            unique.append(c)

    return score_candidates(unique)
