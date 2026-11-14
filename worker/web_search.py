"""Simple web search for location verification.

When a user suggests a location for a news story, this module can
search the web to verify if the location is plausible. Uses a simple
approach: search for the article title + location and check if the
results confirm the connection.

Usage:
    from worker.web_search import verify_location
    result = verify_location("Xbox Series X25", "Seattle, Washington")
    # result: {"verified": True, "confidence": 0.8, "reasoning": "..."}
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx

log = logging.getLogger("xyzo.web_search")

# Simple search using DuckDuckGo Lite (no API key required).
SEARCH_URL = "https://lite.duckduckgo.com/lite/"
USER_AGENT = "xyzo-verify/1.0 (https://xyzo.org; contact@xyzo.org)"


def verify_location(title: str, suggested_location: str,
                    timeout: float = 10.0) -> dict:
    """Verify if a suggested location is plausible for a news article.

    Searches for the article title + location and checks if the results
    confirm the connection. Returns a dict with:
      - verified: bool — whether the location seems plausible
      - confidence: float — 0.0-1.0 confidence in the verification
      - reasoning: str — explanation of the verification result
      - search_results: list — top search results (for debugging)
    """
    if not title or not suggested_location:
        return {
            "verified": False,
            "confidence": 0.0,
            "reasoning": "Missing title or location",
            "search_results": [],
        }

    # Build search query: article title + suggested location.
    query = f"{title} {suggested_location}"

    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(SEARCH_URL, params={"q": query},
                              headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
            html = resp.text

        # Extract search results from DuckDuckGo Lite HTML.
        # Look for result snippets that mention the location.
        results = _extract_results(html)
        location_lower = suggested_location.lower()
        title_lower = title.lower()

        # Check if any result mentions both the title and location.
        confirmed = 0
        for result in results:
            snippet = result.get("snippet", "").lower()
            result_title = result.get("title", "").lower()
            if (location_lower in snippet or location_lower in result_title):
                if any(word in snippet or word in result_title
                       for word in title_lower.split()[:3]):
                    confirmed += 1

        if confirmed > 0:
            return {
                "verified": True,
                "confidence": min(0.9, 0.5 + confirmed * 0.2),
                "reasoning": f"Found {confirmed} search results connecting '{title}' to '{suggested_location}'",
                "search_results": results[:5],
            }
        else:
            return {
                "verified": False,
                "confidence": 0.3,
                "reasoning": f"No search results connecting '{title}' to '{suggested_location}'",
                "search_results": results[:5],
            }

    except Exception as e:
        log.warning("Web search failed: %s", e)
        return {
            "verified": False,
            "confidence": 0.0,
            "reasoning": f"Search failed: {e}"[:200],
            "search_results": [],
        }


def _extract_results(html: str) -> list[dict]:
    """Extract search results from DuckDuckGo Lite HTML."""
    results = []
    # DuckDuckGo Lite has a simple structure: result links and snippets.
    # Look for result blocks.
    result_blocks = re.findall(
        r'<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)</a>.*?'
        r'<td[^>]*class="result-snippet"[^>]*>(.*?)</td>',
        html, re.DOTALL
    )
    for url, title, snippet in result_blocks[:10]:
        # Clean HTML tags from snippet.
        clean_snippet = re.sub(r'<[^>]+>', ' ', snippet).strip()
        clean_snippet = re.sub(r'\s+', ' ', clean_snippet)
        results.append({
            "url": url,
            "title": title.strip(),
            "snippet": clean_snippet[:300],
        })
    return results
