"""Paywall detection script — checks sources for paywall indicators.

Run periodically to identify and disable sources that:
1. Return 403/402/401 status codes
2. Have very short article bodies (empty RSS summaries)
3. Contain paywall keywords in their HTML

Usage:
    python3 -m worker.check_paywalls              # Check all active sources
    python3 -m worker.check_paywalls --dry-run     # Preview only, no changes
    python3 -m worker.check_paywalls --source-id 5 # Check specific source
"""

import argparse
import logging
import re
import sys
from typing import Optional

import httpx

from .db import connect

log = logging.getLogger("xyzo.check_paywalls")

# Known paywall indicators in HTML (must be in main content, not comments/footers)
PAYWALL_KEYWORDS = [
    "subscribe to continue reading",
    "sign in to continue reading",
    "this article is for subscribers only",
    "subscriber exclusive",
    "create an account to read",
    "join to continue reading",
    "this content requires a subscription",
    "this content is for subscribers",
    "members only",
    "for subscribers only",
    "upgrade to read",
    "unlock this article",
    "digital subscription required",
    "subscription required to view",
]

# Known paywalled domains (never try to fetch these)
KNOWN_PAYWALLED_DOMAINS = {
    "economist.com",
    "www.economist.com",
    "wsj.com",
    "www.wsj.com",
    "ft.com",
    "www.ft.com",
    "bloomberg.com",
    "www.bloomberg.com",
    "nytimes.com",
    "www.nytimes.com",
    "washingtonpost.com",
    "www.washingtonpost.com",
    "barrons.com",
    "www.barrons.com",
    "newyorker.com",
    "www.newyorker.com",
    "foreignaffairs.com",
    "www.foreignaffairs.com",
    "foreignpolicy.com",
    "www.foreignpolicy.com",
    "thetimes.co.uk",
    "www.thetimes.co.uk",
    "telegraph.co.uk",
    "www.telegraph.co.uk",
    "spectator.co.uk",
    "www.spectator.co.uk",
    "hbr.org",
    "www.hbr.org",
    "nature.com",
    "www.nature.com",
    "science.org",
    "www.science.org",
    "thelancet.com",
    "www.thelancet.com",
    "nejm.org",
    "www.nejm.org",
}


def get_domain(url: str) -> str:
    """Extract domain from URL."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    return parsed.netloc.lower()


def check_url_accessibility(url: str, timeout: float = 10.0) -> dict:
    """Check if a URL is accessible and not paywalled."""
    result = {
        "url": url,
        "status": None,
        "accessible": False,
        "paywall_detected": False,
        "paywall_reason": None,
        "body_length": 0,
    }

    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; XyzoBot/1.0)",
                "Accept": "text/html,application/xhtml+xml",
            })

            result["status"] = response.status_code
            result["body_length"] = len(response.text)

            # Check for HTTP status paywall indicators
            if response.status_code in (401, 402, 403):
                result["paywall_detected"] = True
                result["paywall_reason"] = f"HTTP {response.status_code}"
                return result

            if response.status_code == 451:
                result["paywall_detected"] = True
                result["paywall_reason"] = "Unavailable For Legal Reasons"
                return result

            # Check for paywall keywords in HTML (only in main content area)
            # Extract text between <article> or <main> tags to avoid false positives
            html_lower = response.text.lower()
            
            # Try to find main content area
            content_start = 0
            content_end = len(html_lower)
            for tag in ["<article", "<main", '<div class="content"', '<div class="article"']:
                idx = html_lower.find(tag)
                if idx != -1:
                    content_start = idx
                    break
            
            content_html = html_lower[content_start:content_end]
            
            for keyword in PAYWALL_KEYWORDS:
                if keyword in content_html:
                    result["paywall_detected"] = True
                    result["paywall_reason"] = f"Keyword: {keyword}"
                    return result

            # Check for very short content (likely blocked)
            if response.status_code == 200 and result["body_length"] < 500:
                result["paywall_detected"] = True
                result["paywall_reason"] = f"Very short content ({result['body_length']} chars)"
                return result

            result["accessible"] = True
            return result

    except httpx.TimeoutException:
        result["paywall_reason"] = "Timeout"
        return result
    except httpx.RequestError as e:
        result["paywall_reason"] = f"Request error: {type(e).__name__}"
        return result


def check_source_articles(source_id: int, limit: int = 5) -> dict:
    """Check a source's articles for paywall indicators."""
    with connect() as conn, conn.cursor() as cur:
        # Get source info
        cur.execute("""
            SELECT id, name, feed_url, active, error_count, reliability_score
            FROM news_sources WHERE id = %s
        """, (source_id,))
        source = cur.fetchone()
        if not source:
            return {"error": "Source not found"}

        # Get sample articles
        cur.execute("""
            SELECT id, url, title, body, status
            FROM news_articles
            WHERE source_id = %s
            ORDER BY fetched_at DESC
            LIMIT %s
        """, (source_id, limit))
        articles = cur.fetchall()

        # Check average body length
        body_lengths = [len(a["body"] or "") for a in articles]
        avg_body_len = sum(body_lengths) / len(body_lengths) if body_lengths else 0

        # Check domain against known paywalled list
        domain = get_domain(source["feed_url"])
        is_known_paywall = domain in KNOWN_PAYWALLED_DOMAINS

        # Check sample article URLs
        url_results = []
        for article in articles[:3]:  # Check up to 3 URLs
            if article["url"]:
                result = check_url_accessibility(article["url"])
                url_results.append(result)

        # Determine if source is paywalled
        paywall_detected = False
        paywall_reasons = []

        if is_known_paywall:
            paywall_detected = True
            paywall_reasons.append(f"Known paywalled domain: {domain}")

        if avg_body_len < 100:
            paywall_detected = True
            paywall_reasons.append(f"Very short avg body: {avg_body_len:.0f} chars")

        for url_result in url_results:
            if url_result["paywall_detected"]:
                paywall_detected = True
                paywall_reasons.append(url_result["paywall_reason"])

        return {
            "source_id": source_id,
            "source_name": source["name"],
            "feed_url": source["feed_url"],
            "active": source["active"],
            "error_count": source["error_count"],
            "reliability_score": source["reliability_score"],
            "article_count": len(articles),
            "avg_body_length": avg_body_len,
            "is_known_paywall": is_known_paywall,
            "paywall_detected": paywall_detected,
            "paywall_reasons": paywall_reasons,
            "url_results": url_results,
        }


def disable_source(source_id: int, reason: str) -> None:
    """Disable a source and mark it as paywalled."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_sources 
            SET active = false, 
                error_count = 99,
                reliability_score = 0.0
            WHERE id = %s
        """, (source_id,))
        conn.commit()
        log.info("Disabled source %d: %s", source_id, reason)


def delete_source_articles(source_id: int, min_body_len: int = 200) -> int:
    """Delete articles from a source with short body content."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            DELETE FROM news_articles
            WHERE source_id = %s
            AND (body IS NULL OR length(body) < %s)
        """, (source_id, min_body_len))
        deleted = cur.rowcount
        conn.commit()
        return deleted


def run(dry_run: bool = False, source_id: Optional[int] = None, min_body_len: int = 200) -> dict:
    """Run paywall detection on all active sources."""
    summary = {"checked": 0, "paywalled": 0, "disabled": 0, "articles_deleted": 0}

    with connect() as conn, conn.cursor() as cur:
        if source_id:
            cur.execute("SELECT id FROM news_sources WHERE id = %s", (source_id,))
        else:
            cur.execute("SELECT id FROM news_sources WHERE active = true ORDER BY id")
        sources = cur.fetchall()

    log.info("Checking %d sources for paywall indicators...", len(sources))

    for source in sources:
        sid = source["id"]
        result = check_source_articles(sid)
        summary["checked"] += 1

        if result.get("paywall_detected"):
            summary["paywalled"] += 1
            reasons = ", ".join(result.get("paywall_reasons", []))
            log.warning("PAYWALL DETECTED: %s (ID: %d) — %s", 
                       result.get("source_name"), sid, reasons)

            if not dry_run:
                disable_source(sid, reasons)
                deleted = delete_source_articles(sid, min_body_len)
                summary["disabled"] += 1
                summary["articles_deleted"] += deleted
                log.info("Disabled source %d, deleted %d articles", sid, deleted)
            else:
                log.info("[DRY RUN] Would disable source %d", sid)

    return summary


def main():
    parser = argparse.ArgumentParser(description="Check sources for paywall indicators")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no changes")
    parser.add_argument("--source-id", type=int, help="Check specific source")
    parser.add_argument("--min-body-len", type=int, default=200, help="Min body length to keep")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s"
    )

    summary = run(
        dry_run=args.dry_run,
        source_id=args.source_id,
        min_body_len=args.min_body_len,
    )

    print(f"\nSummary:")
    print(f"  Checked: {summary['checked']} sources")
    print(f"  Paywalled: {summary['paywalled']}")
    print(f"  Disabled: {summary['disabled']}")
    print(f"  Articles deleted: {summary['articles_deleted']}")


if __name__ == "__main__":
    main()
