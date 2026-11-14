"""URL validator — checks if a URL is paywalled, login-required, or accessible.

Used to verify user reports about paywalls/login requirements.
Runs as a background job and updates the report status.

Usage:
    from worker.url_validator import validate_url, validate_reported_urls
    result = validate_url("https://example.com/article")
    # → {accessible: bool, paywalled: bool, login_required: bool, ...}
"""
from __future__ import annotations

import logging
import re
import time
from urllib.parse import urlparse

import httpx

from .db import connect

log = logging.getLogger("xyzo.url_validator")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Common paywall indicators in HTML
PAYWALL_INDICATORS = [
    # Hard paywall markers
    re.compile(r'class="[^"]*paywall[^"]*"', re.I),
    re.compile(r'class="[^"]*subscriber[^"]*"', re.I),
    re.compile(r'id="[^"]*paywall[^"]*"', re.I),
    re.compile(r'data-paywall', re.I),
    # Common paywall text
    re.compile(r'(?:subscribe|subscription)\s+(?:to|for|now)\s+(?:read|access|continue)', re.I),
    re.compile(r'(?:this\s+)?(?:article|story|content)\s+is\s+(?:for|only\s+for)\s+(?:subscribers?|members?)', re.I),
    re.compile(r'(?:sign\s+in|log\s+in|subscribe)\s+(?:to|for)\s+(?:read|access|continue)', re.I),
    re.compile(r'(?:reached?|exceeded?)\s+(?:your|the)\s+(?:free|monthly)\s+(?:limit|articles?)', re.I),
    # Metered paywall
    re.compile(r'(?:\d+)\s+(?:of|out\s+of)\s+(?:\d+)\s+(?:free\s+)?articles?', re.I),
]

# Login requirement indicators
LOGIN_INDICATORS = [
    re.compile(r'class="[^"]*login[^"]*wall[^"]*"', re.I),
    re.compile(r'class="[^"]*signin[^"]*wall[^"]*"', re.I),
    re.compile(r'(?:please|must|sign|log)\s+(?:in|into)\s+(?:to|before)\s+(?:read|access|continue)', re.I),
    re.compile(r'(?:create|need)\s+(?:an?\s+)?(?:account|subscription)\s+(?:to|for)\s+(?:read|access)', re.I),
]

# Indicators that content is accessible (not paywalled)
ACCESSIBLE_INDICATORS = [
    re.compile(r'<article[^>]*>[\s\S]{500,}', re.I),  # Long article tag
    re.compile(r'class="[^"]*article[_-]?body[^"]*"', re.I),
    re.compile(r'class="[^"]*story[_-]?content[^"]*"', re.I),
    re.compile(r'class="[^"]*entry[_-]?content[^"]*"', re.I),
]


def validate_url(url: str, timeout: float = 15) -> dict:
    """Check if a URL is accessible, paywalled, or login-required.

    Returns:
        {
            url: str,
            accessible: bool,
            paywalled: bool,
            login_required: bool,
            status_code: int,
            content_length: int,
            indicators: [str],  # matched patterns
            title: str | None,
            error: str | None,
        }
    """
    result = {
        "url": url,
        "accessible": False,
        "paywalled": False,
        "login_required": False,
        "status_code": 0,
        "content_length": 0,
        "indicators": [],
        "title": None,
        "error": None,
    }

    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            resp = client.get(url)
            result["status_code"] = resp.status_code
            result["content_length"] = len(resp.content)

            if resp.status_code == 403:
                result["paywalled"] = True
                result["indicators"].append("HTTP 403 Forbidden")
                return result

            if resp.status_code == 401:
                result["login_required"] = True
                result["indicators"].append("HTTP 401 Unauthorized")
                return result

            if resp.status_code >= 400:
                result["error"] = f"HTTP {resp.status_code}"
                return result

            html = resp.text[:50000]  # Check first 50k chars

            # Extract title
            title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.DOTALL)
            if title_match:
                result["title"] = re.sub(r'<[^>]+>', '', title_match.group(1)).strip()[:200]

            # Check for paywall indicators
            for pattern in PAYWALL_INDICATORS:
                if pattern.search(html):
                    result["paywalled"] = True
                    result["indicators"].append(pattern.pattern[:50])
                    break

            # Check for login indicators
            for pattern in LOGIN_INDICATORS:
                if pattern.search(html):
                    result["login_required"] = True
                    result["indicators"].append(pattern.pattern[:50])
                    break

            # Check for accessible content
            if not result["paywalled"] and not result["login_required"]:
                for pattern in ACCESSIBLE_INDICATORS:
                    if pattern.search(html):
                        result["accessible"] = True
                        break

                # If no clear indicator, check content length
                if not result["accessible"] and len(html) > 5000:
                    result["accessible"] = True

    except httpx.TimeoutException:
        result["error"] = "Timeout"
    except httpx.ConnectError:
        result["error"] = "Connection failed"
    except Exception as e:
        result["error"] = str(e)[:200]

    return result


def validate_reported_urls(limit: int = 50) -> dict:
    """Validate URLs that have been reported as paywalled/login-required.

    Checks each URL and updates the report status.
    Also flags other articles from the same domain.
    """
    with connect() as conn, conn.cursor() as cur:
        # Get reports that haven't been validated yet
        cur.execute("""
            SELECT r.id, r.article_id, r.report_type, r.reason,
                   a.url, a.title, a.source_id,
                   s.name as source_name, s.country as source_country, s.feed_url
            FROM news_quality_reports r
            JOIN news_articles a ON a.id = r.article_id
            LEFT JOIN news_sources s ON s.id = a.source_id
            WHERE r.report_type IN ('paywall', 'login_required')
              AND r.validation_status IS NULL
            ORDER BY r.created_at DESC
            LIMIT %s
        """, (limit,))
        reports = cur.fetchall()

    validated = 0
    confirmed = 0
    rejected = 0
    domain_flags = 0

    for report in reports:
        url = report.get("url")
        if not url:
            continue

        # Validate the URL
        result = validate_url(url)
        is_paywalled = result["paywalled"] or result["login_required"]

        with connect() as conn, conn.cursor() as cur:
            # Update the report validation status
            cur.execute("""
                UPDATE news_quality_reports
                SET validation_status = %s,
                    validation_details = %s,
                    validated_at = now()
                WHERE id = %s
            """, (
                "confirmed" if is_paywalled else "rejected",
                json.dumps(result),
                report["id"],
            ))

            if is_paywalled:
                confirmed += 1

                # Flag all articles from the same domain
                domain = urlparse(url).netloc
                if domain:
                    cur.execute("""
                        UPDATE news_articles
                        SET quality_score = GREATEST(0, quality_score - 0.2),
                            report_count = report_count + 1
                        WHERE url LIKE %s
                          AND id != %s
                          AND quality_score > 0.3
                    """, (f"%{domain}%", report["article_id"]))
                    domain_flags += cur.rowcount

                    # Also flag the source
                    if report.get("source_id"):
                        cur.execute("""
                            UPDATE news_sources
                            SET reliability_score = GREATEST(0, reliability_score - 0.1)
                            WHERE id = %s
                        """, (report["source_id"],))
            else:
                rejected += 1

        validated += 1

    return {
        "validated": validated,
        "confirmed": confirmed,
        "rejected": rejected,
        "domain_flags": domain_flags,
    }


def find_replacement_sources(source_id: int) -> list[dict]:
    """Find replacement sources for a flagged source.

    Searches for sources in the same country/region that are active
    and have good reliability scores.
    """
    with connect() as conn, conn.cursor() as cur:
        # Get the flagged source's details
        cur.execute("""
            SELECT id, name, country, region, language, feed_url
            FROM news_sources
            WHERE id = %s
        """, (source_id,))
        source = cur.fetchone()

    if not source:
        return []

    country = source.get("country")
    region = source.get("region")

    # Find active sources in the same country/region
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, country, region, language, feed_url,
                   reliability_score, last_success_at, error_count
            FROM news_sources
            WHERE active = TRUE
              AND id != %s
              AND (country = %s OR region = %s)
              AND reliability_score >= 0.5
              AND error_count < 5
            ORDER BY reliability_score DESC, last_success_at DESC
            LIMIT 10
        """, (source_id, country, region))
        replacements = cur.fetchall()

    return [{
        "id": r["id"],
        "name": r["name"],
        "country": r["country"],
        "region": r["region"],
        "language": r["language"],
        "feed_url": r["feed_url"],
        "reliability_score": float(r["reliability_score"]) if r["reliability_score"] else 0,
        "last_success_at": r["last_success_at"],
        "error_count": r["error_count"],
    } for r in replacements]


import json
