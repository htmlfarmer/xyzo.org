"""journalist_resolver — map articles to journalist entities.

Runs as part of nightly pipeline. For each unprocessed article:

1. Extract author name from body (byline patterns, JSON-LD, HTML)
2. Extract author URL if present (author page links in HTML)
3. Find or create journalist entity
4. Link article → journalist with evidence
5. Update journalist stats

Usage:
    python3 -m worker.journalist_resolver          # run once
    python3 -m worker.journalist_resolver --watch  # continuously
    python3 -m worker.journalist_resolver --dry-run
    python3 -m worker.journalist_resolver --article-id 12345
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import sys
from urllib.parse import urljoin, urlparse

from .db import connect
from .robots import RobotsCache

log = logging.getLogger("xyzo.journalist_resolver")

# ── Byline patterns ─────────────────────────────────────────────────────────
_RE_BYLINE = re.compile(
    r"(?i)"
    r"^\s*(?:by|written\s+by|author|reported\s+by|reporter|"
    r"from|contributed\s+by|staff\s+writer|editor):?\s*"
    r"([A-Z][a-zA-Z''-]+(?:\s+[A-Z][a-zA-Z''-]+){0,4}?)"
    r"(?:\s+[A-Z]{2,})?(?:\s*[\n\r,|]|\s*<|\s*$)",
    re.M,
)
_RE_BYLINE_EMAIL = re.compile(
    r"(?i)(?:by|written\s+by|author):?\s*([^<\n]{3,50}?)\s*"
    r"<([^>\s]+@[^>\s]+)>",
)
_RE_JSON_LD_AUTHOR = re.compile(
    r'"author"\s*:\s*\{\s*"@type"\s*:\s*"Person"\s*,\s*"name"\s*:\s*"([^"]+)"',
    re.DOTALL,
)
_RE_JSON_LD_AUTHOR_ARRAY = re.compile(
    r'"author"\s*:\s*\[\s*\{\s*"@type"\s*:\s*"Person"\s*,\s*"name"\s*:\s*"([^"]+)"',
    re.DOTALL,
)
_RE_META_AUTHOR = re.compile(
    r'<meta\s[^>]*name=["\']author["\'][^>]*content=["\']([^"\']{2,80})["\']',
    re.I,
)
_RE_AUTHOR_AHREF = re.compile(
    r'<a\s[^>]*href=["\'](/author/[^"\']+|[^"\']*/author/[^"\']+)["\'][^>]*>'
    r'\s*([A-Z][a-zA-Z''-]+(?:\s+[A-Z][a-zA-Z''-]+){0,3})\s*</a>',
    re.I,
)
_RE_CAMEL_CASE_NAME = re.compile(r"\b([A-Z][a-z]+ [A-Z][a-z]+)\b")

# ── Author page URL patterns by domain ─────────────────────────────────────
AUTHOR_URL_PATTERNS = [
    re.compile(r'/author/([^/\?]+)'),
    re.compile(r'/contributors?/([^/\?]+)'),
    re.compile(r'/people/([^/\?]+)'),
    re.compile(r'/profile/([^/\?]+)'),
    re.compile(r'/writers?/([^/\?]+)'),
]

# ── Bio paragraph patterns (author name in bio paragraph) ──────────────────
# Handles both raw <p> and HTML-encoded &lt;p&gt;
_RE_BIO_PARAGRAPH = re.compile(
    r'(?:&lt;p&gt;|<p>)\s*([A-Z][a-zA-Z''-]{2,20})\s+(?:has|is a|is an|is the)\s+(?:\w+\s+){0,15}'
    r'(?:writing|reporting|covering|working|freelance|journalist|reporter'
    r'|editor|technology|science|staff)',
    re.I,
)


def _extract_byline(body: str, url: str) -> tuple[str | None, str | None, str]:
    """Extract author name and author page URL from article body+URL.

    Returns (name, author_url, evidence_type)
    """
    name = None
    author_url = None
    evidence = "none"

    # 1. JSON-LD author
    m = _RE_JSON_LD_AUTHOR.search(body)
    if not m:
        m = _RE_JSON_LD_AUTHOR_ARRAY.search(body)
    if m:
        name = m.group(1).strip()
        evidence = "json_ld"

    # 2. Meta author tag
    if not name:
        m = _RE_META_AUTHOR.search(body)
        if m:
            name = m.group(1).strip()
            evidence = "meta_author"

    # 3. Byline email pattern (By Author <email@...>)
    if not name:
        m = _RE_BYLINE_EMAIL.search(body)
        if m:
            name = m.group(1).strip()
            evidence = "byline_email"

    # 4. Standard byline at start of body
    if not name:
        m = _RE_BYLINE.match(body[:500])
        if m:
            name = m.group(1).strip()
            evidence = "byline"

    # 5. Author <a> link
    if not name:
        m = _RE_AUTHOR_AHREF.search(body[:2000])
        if m:
            author_url = m.group(1)
            name = m.group(2).strip()
            evidence = "author_link"

    # 6. Author page URL in URL path
    if not author_url:
        for pat in AUTHOR_URL_PATTERNS:
            m = pat.search(url)
            if m:
                author_url = m.group(1)
                if not name:
                    name = author_url.replace("-", " ").replace("_", " ").title()
                    evidence = "url_path"
                break

    # 7. Bio paragraph pattern (e.g. <p>Efosa has been writing about...)
    if not name:
        m = _RE_BIO_PARAGRAPH.search(body[:3000])
        if m:
            name = m.group(1).strip()
            evidence = "bio_paragraph"

    return name, author_url, evidence


def _clean_name(name: str) -> str:
    """Normalize a name for matching."""
    return re.sub(r"[^a-z]", "", name.lower()[:30])


def _is_valid_name(name: str | None) -> bool:
    """Check if extracted text looks like a real person's name."""
    if not name or len(name) < 3:
        return False
    words = name.strip().split()
    if len(words) > 5 or len(words) == 0:
        return False
    if any(len(w) < 2 for w in words):
        return False
    # All words should start with uppercase (real names)
    if not all(w[0].isupper() for w in words if w):
        return False
    # Reject common English stopwords/phrases that aren't names
    STOPWORDS = {"the", "and", "for", "with", "from", "this", "that", "have",
                  "has", "was", "were", "been", "being", "but", "not", "you",
                  "your", "are", "nor", "our", "menus", "late", "night",
                  "revamped", "durability", "cameras", "battery", "former",
                  "military", "meteorologist", "expert", "report", "staff",
                  "said", "says", "according"}
    if any(w.lower() in STOPWORDS for w in words):
        return False
    # Reject single very short words (< 4 chars) unless they look like proper names
    # Allow names like "Bo", "Ma", "Li" etc.
    if len(words) == 1 and len(words[0]) < 4:
        return False
    return True


def _clean_author_name(name: str) -> str:
    """Remove trailing ALL-CAPS words and validate it looks like a real name."""
    if not name:
        return ""
    words = name.strip().split()
    # Strip trailing ALL-CAPS words (dateline cities, job titles)
    while words and words[-1].isupper() and len(words[-1]) > 2:
        words = words[:-1]
    # Strip words that look like stopwords or garbage
    STOPWORDS = {"the", "and", "for", "with", "from", "this", "that", "have",
                  "has", "was", "were", "been", "being", "but", "not", "you",
                  "your", "are", "not", "nor", "our", "menus", "late",
                  "night", "revamped", "durability", "cameras", "battery",
                  "former", "military", "meteorologist"}
    words = [w for w in words if w.lower() not in STOPWORDS]
    cleaned = " ".join(words).strip()
    # Validate it looks like a real name
    if not _is_valid_name(cleaned):
        return ""
    return cleaned


def _infer_journalist_type(bio_text: str | None, org_name: str | None) -> str:
    """Infer journalist type from bio and organization."""
    if not bio_text and not org_name:
        return "unknown"
    text = f"{bio_text or ''} {org_name or ''}".lower()
    if any(w in text for w in ["freelance", "independent", "contributor"]):
        return "freelance"
    if any(w in text for w in ["editor", "editorial"]):
        return "editor"
    if any(w in text for w in ["correspondent", "reporter"]):
        return "correspondent"
    if any(w in text for w in ["academic", "professor", "researcher", "phd", "university"]):
        return "academic"
    if any(w in text for w in ["blogger", "personal", "independent"]):
        return "blogger"
    return "unknown"


def _infer_topics(title: str, body: str, existing_topics: list[str]) -> list[str]:
    """Infer topics from article text."""
    topics: set[str] = set(existing_topics)
    text = f"{title} {body[:2000]}".lower()
    topic_keywords = {
        "technology": ["technology", "tech", "ai", "software", "hardware", "digital"],
        "science": ["science", "research", "study", "scientist", "laboratory", "discovery"],
        "politics": ["politics", "government", "election", "policy", "congress", "parliament"],
        "business": ["business", "company", "startup", "investment", "market", "finance"],
        "health": ["health", "medical", "disease", "hospital", "doctor", "patient"],
        "climate": ["climate", "environment", "emissions", "carbon", "renewable", "sustainability"],
        "space": ["space", "nasa", "rocket", "satellite", "astronomy", "asteroid"],
        "energy": ["energy", "oil", "gas", "electricity", "power", "solar", "wind"],
        "data_center": ["data center", "data centre", "server", "cloud", "infrastructure"],
        "water": ["water", "drought", "flood", "river", "aquifer"],
    }
    for topic, keywords in topic_keywords.items():
        if any(kw in text for kw in keywords):
            topics.add(topic)
    return sorted(topics)


def resolve_article(article_id: int, dry_run: bool = False) -> dict:
    """Extract journalist info from a single article and create/link entity.

    Priority:
      1. news_article_authors (captured at ingestion time — most reliable)
      2. Fall back to body parsing (less reliable, many RSS feeds strip bylines)
    """
    with connect() as conn:
        article = conn.execute(
            """
            SELECT a.id, a.url, a.title, a.body, a.source_id,
                   s.name as source_name, s.homepage_url, s.country as source_country
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.id = %s
            """,
            (article_id,),
        ).fetchone()

    if not article:
        return {"article_id": article_id, "status": "not_found"}

    body = article["body"] or ""
    url = article["url"] or ""
    source_name = article["source_name"] or ""
    homepage = article["homepage_url"] or ""
    source_country = article["source_country"] or ""

    # Priority 1: use news_article_authors (captured at fetch time)
    with connect() as conn2:
        author_row = conn2.execute(
            """
            SELECT author_name, author_url, bio_paragraph, evidence_type, confidence
            FROM news_article_authors
            WHERE article_id = %s
            """,
            (article_id,),
        ).fetchone()

    if author_row and author_row["author_name"]:
        name = author_row["author_name"]
        author_url = author_row["author_url"]
        evidence = author_row["evidence_type"] or "ingestion_author"
        bio_paragraph = author_row["bio_paragraph"]
        conn_use = conn2
    else:
        name, author_url, evidence = _extract_byline(body, url)
        bio_paragraph = None
        if not name:
            return {"article_id": article_id, "status": "no_byline", "url": url}

    # Clean name (remove trailing ALL-CAPS words like dateline cities)
    name = _clean_author_name(name)
    if not name:
        return {"article_id": article_id, "status": "no_byline", "url": url}
    canonical = re.sub(r"\s+", " ", name.strip())

    if dry_run:
        return {
            "article_id": article_id,
            "name": canonical,
            "author_url": author_url,
            "evidence": evidence,
            "source": source_name,
        }

    with connect() as conn:
        # Find or create journalist
        existing = conn.execute(
            """
            SELECT id, canonical_name, article_count, topics
            FROM news_journalists
            WHERE REPLACE(REPLACE(REPLACE(
                LOWER(canonical_name), ' ', ''), '-', ''), '''', '') = %s
            LIMIT 1
            """,
            (_clean_name(canonical),),
        ).fetchone()

        if existing:
            journalist_id = existing["id"]
            # Update article count
            conn.execute(
                "UPDATE news_journalists SET article_count = article_count + 1, "
                "last_seen_at = NOW() WHERE id = %s",
                (journalist_id,),
            )
            log.info("  linked article %s → journalist %s (%s)",
                     article_id, journalist_id, canonical)
        else:
            insert_result = conn.execute(
                """
                INSERT INTO news_journalists (
                    canonical_name, display_name,
                    journalist_type, employment_status,
                    organization_name, profile_status,
                    article_count, first_seen_at, last_seen_at,
                    identity_confidence
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW(), %s)
                RETURNING id
                """,
                (
                    canonical, canonical,
                    "unknown", "active",
                    source_name, "auto",
                    1, 0.4,
                ),
            )
            journalist_id = insert_result.fetchone()["id"]
            log.info("  created journalist %s: %s", journalist_id, canonical)

        # Link article → journalist
        conn.execute(
            """
            INSERT INTO news_article_journalists (
                article_id, journalist_id, relationship,
                evidence_type, source_text, author_url_found, confidence
            )
            VALUES (%s, %s, 'author', %s, %s, %s, %s)
            ON CONFLICT (article_id, journalist_id, relationship) DO NOTHING
            """,
            (article_id, journalist_id, evidence, name[:200], author_url, 0.7),
        )

        # Extract bio from body if present (common pattern: author bio at end)
        # Handle both raw <p> and HTML-encoded &lt;p&gt;
        # Make closing tag optional since some feeds strip it
        bio_pattern = (
            r'(?:&lt;p&gt;|<p>)[^<]*' +
            re.escape(name.split()[0]) +
            r'[^<]{10,300}?'
            r'(?:PhD|Master|Bachelor|Science|journalist|writer|reporting|reporter)'
            r'[^<]{0,300}'
            r'(?:&lt;/p&gt;|</p>)?'
        )
        bio_match = re.search(bio_pattern, body, re.DOTALL | re.IGNORECASE)
        if bio_match:
            bio_text = re.sub(r"<[^>]+>", "", bio_match.group()).strip()[:500]
            conn.execute(
                "UPDATE news_journalists SET bio = COALESCE(bio, %s) "
                "WHERE id = %s AND bio IS NULL",
                (bio_text, journalist_id),
            )

        # Extract location from article (source country is weak signal)
        if source_country:
            conn.execute(
                """
                UPDATE news_journalists
                SET country = COALESCE(country, %s),
                    location_confidence = GREATEST(
                        location_confidence,
                        CASE WHEN country = %s THEN location_confidence + 0.05
                             ELSE 0.1 END
                    )
                WHERE id = %s
                """,
                (source_country, source_country, journalist_id),
            )

        # Update topics
        topics = _infer_topics(article["title"] or "", body, [])
        if topics:
            conn.execute(
                "UPDATE news_journalists SET topics = topics || %s WHERE id = %s",
                (topics, journalist_id),
            )

        # Store author URL for crawling
        if author_url:
            source_domain = urlparse(homepage).netloc if homepage else urlparse(url).netloc
            full_author_url = author_url if author_url.startswith("http") else (
                f"{urlparse(homepage).scheme}://{source_domain}{author_url}"
                if homepage else urljoin(url, author_url)
            )
            conn.execute(
                """
                INSERT INTO news_author_urls (
                    journalist_id, source_id, author_url, author_name_text, is_active,
                    last_checked_at, article_count
                )
                VALUES (%s, %s, %s, %s, TRUE, NOW(), 1)
                ON CONFLICT (source_id, author_url) DO UPDATE SET
                    journalist_id   = COALESCE(news_author_urls.journalist_id, EXCLUDED.journalist_id),
                    author_name_text = COALESCE(EXCLUDED.author_name_text, news_author_urls.author_name_text),
                    last_article_at = NOW(),
                    article_count   = news_author_urls.article_count + 1
                """,
                (
                    journalist_id, article["source_id"],
                    full_author_url, canonical,
                ),
            )

        conn.commit()

    return {
        "article_id": article_id,
        "journalist_id": journalist_id,
        "name": canonical,
        "evidence": evidence,
        "author_url": author_url,
    }


def run(limit: int = 5000, dry_run: bool = False, watch: bool = False,
        article_id: int | None = None) -> dict:
    """Run the journalist resolver on recent unprocessed articles."""
    stats = {"processed": 0, "journalists_found": 0, "journalists_created": 0,
             "no_byline": 0, "errors": 0}

    if article_id:
        result = resolve_article(article_id, dry_run=dry_run)
        print(json.dumps(result, indent=2))
        return result

    query = """
        SELECT a.id
        FROM news_articles a
        LEFT JOIN news_article_journalists aj ON aj.article_id = a.id
        WHERE aj.id IS NULL
          AND a.status IN ('extracted', 'pending', 'unlocated')
          AND a.body IS NOT NULL
          AND LENGTH(a.body) > 100
        ORDER BY a.published_at DESC NULLS LAST
        LIMIT %s
    """

    with connect() as conn:
        articles = [row["id"] for row in conn.execute(query, (limit,)).fetchall()]

    log.info("journalist_resolver: %s unprocessed articles", len(articles))

    for aid in articles:
        try:
            result = resolve_article(aid, dry_run=dry_run)
            if result.get("status") == "no_byline":
                stats["no_byline"] += 1
            elif result.get("journalist_id"):
                stats["journalists_found"] += 1
            elif result.get("status") == "not_found":
                pass  # skip
            stats["processed"] += 1
        except Exception as e:
            log.error("Error resolving article %s: %s", aid, e)
            stats["errors"] += 1

        if not watch and stats["processed"] % 500 == 0:
            log.info("  processed %s/%s", stats["processed"], len(articles))

    log.info("journalist_resolver: %s", json.dumps(stats))
    return stats


if __name__ == "__main__":
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(description="Resolve journalists from articles")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--article-id", type=int)
    args = parser.parse_args()

    os.environ.setdefault(
        "XYZO_DB_DSN",
        os.environ.get("XYZO_DB_URL", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"),
    )

    run(
        limit=args.limit,
        dry_run=args.dry_run,
        watch=args.watch,
        article_id=args.article_id,
    )
