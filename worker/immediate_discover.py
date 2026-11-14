"""Immediate news source discovery — no AI required.

Searches the internet for RSS feeds and news websites for a given
region using web search, RSS directories, and common URL patterns.
Validates feeds immediately and starts fetching articles.

Usage:
    from worker.immediate_discover import discover_and_fetch
    result = discover_and_fetch(lat=28.6, lng=77.2, bbox=[76.5,28.0,78.0,29.5])
    # → {sources_found, sources_added, articles_fetched, ...}
"""
from __future__ import annotations

import calendar
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import feedparser
import httpx

from .db import connect
from . import cities_text

log = logging.getLogger("xyzo.immediate_discover")

USER_AGENT = "xyzo-source-finder/0.1 (https://xyzo.org; contact@xyzo.org)"
FEEDS_FILE = Path(__file__).parent / "feeds.json"

# Common RSS feed paths to probe
FEED_PATHS = [
    "/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml",
    "/feeds/posts/default", "/rss/feed", "/news/rss",
    "/rss/all.xml", "/en/rss", "/feed/rss", "/index.xml",
]

# Country name → ISO code
_COUNTRY_NAMES = {
    "korea": "KR", "japan": "JP", "china": "CN", "india": "IN",
    "pakistan": "PK", "bangladesh": "BD", "indonesia": "ID",
    "philippines": "PH", "thailand": "TH", "vietnam": "VN",
    "malaysia": "MY", "singapore": "SG", "australia": "AU",
    "germany": "DE", "france": "FR", "uk": "GB", "united kingdom": "GB",
    "spain": "ES", "italy": "IT", "brazil": "BR", "mexico": "MX",
    "nigeria": "NG", "kenya": "KE", "south africa": "ZA",
    "egypt": "EG", "turkey": "TR", "iran": "IR", "iraq": "IQ",
    "canada": "CA", "us": "US", "usa": "US", "united states": "US",
}


def _detect_country_from_coords(lat: float, lng: float) -> str | None:
    """Detect country code from coordinates using cities database."""
    try:
        stats = cities_text.stats(f"{lat},{lng}")
        if stats and stats.get("primary"):
            return stats["primary"].get("country_code")
    except Exception:
        pass
    return None


def _search_web_for_news(query: str) -> list[str]:
    """Search the web for news websites. Returns list of domains.

    Note: the html.duckduckgo.com endpoint now frequently blocks /
    returns 0 results for bot User-Agents. We use a realistic UA and a
    short timeout so a single failing query can't burn the entire
    60s worker budget — callers fall back to AI suggestions instead.
    """
    domains = []
    try:
        # 8s per-query ceiling: DuckDuckGo usually responds in 1-3s when
        # it works, but the HTML endpoint frequently hangs. Bailing at
        # 8s keeps total web_search time bounded even when every query
        # fails.
        with httpx.Client(timeout=8, follow_redirects=True) as client:
            resp = client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            if resp.status_code == 200:
                # Extract URLs from DuckDuckGo
                url_pattern = re.compile(r'class="result__a"[^>]*href="([^"]+)"', re.I)
                matches = url_pattern.findall(resp.text)
                if not matches:
                    url_pattern2 = re.compile(r'uddg=([^&"]+)', re.I)
                    matches = [u for u in url_pattern2.findall(resp.text)]

                for raw_url in matches[:20]:
                    if "uddg=" in raw_url:
                        from urllib.parse import unquote
                        raw_url = unquote(raw_url.split("uddg=")[1].split("&")[0])
                    try:
                        domain = urlparse(raw_url).netloc.lower()
                        if domain and domain not in domains:
                            domains.append(domain)
                    except Exception:
                        continue
    except Exception as e:
        log.debug("Web search failed for %r: %s", query, e)

    return domains[:15]


def _probe_domain_for_feeds(domain: str) -> list[dict]:
    """Try common RSS paths on a domain. Returns validated feeds."""
    results = []
    seen_urls = set()

    with httpx.Client(timeout=8, follow_redirects=True) as client:
        for path in FEED_PATHS:
            url = f"https://{domain}{path}"
            if url in seen_urls:
                continue
            seen_urls.add(url)

            try:
                resp = client.get(url, headers={"User-Agent": USER_AGENT})
                if resp.status_code != 200:
                    continue

                body = resp.text[:500]
                if not ("<rss" in body or "<feed" in body or "<channel>" in body):
                    content_type = resp.headers.get("content-type", "")
                    if "xml" not in content_type and "rss" not in content_type:
                        continue

                parsed = feedparser.parse(resp.content)
                if parsed.entries:
                    title = parsed.feed.get("title", domain)
                    results.append({
                        "name": title[:200],
                        "feed_url": url,
                        "description": (parsed.feed.get("description") or "")[:500],
                        "entry_count": len(parsed.entries),
                        "valid": True,
                    })
                    break  # Found a working feed
            except Exception:
                continue

            time.sleep(0.2)

    return results


def _get_country_name(country_code: str) -> str:
    """Get country name from ISO code."""
    names = {
        "IN": "India", "PK": "Pakistan", "BD": "Bangladesh", "US": "United States",
        "GB": "United Kingdom", "AU": "Australia", "CA": "Canada", "DE": "Germany",
        "FR": "France", "JP": "Japan", "KR": "South Korea", "CN": "China",
        "BR": "Brazil", "MX": "Mexico", "NG": "Nigeria", "KE": "Kenya",
        "ZA": "South Africa", "EG": "Egypt", "TR": "Turkey", "IR": "Iran",
        "TH": "Thailand", "VN": "Vietnam", "PH": "Philippines", "ID": "Indonesia",
        "MY": "Malaysia", "SG": "Singapore", "NZ": "New Zealand", "IE": "Ireland",
        "IT": "Italy", "ES": "Spain", "NL": "Netherlands", "PL": "Poland",
        "UA": "Ukraine", "SA": "Saudi Arabia", "AE": "UAE", "IQ": "Iraq",
    }
    return names.get(country_code, country_code)


def discover_and_fetch(
    lat: float,
    lng: float,
    bbox: list[float] | None = None,
    country: str | None = None,
    progress_callback=None,
) -> dict:
    """Discover news sources for a region and start fetching immediately.

    No AI required — uses web search + RSS probing + feed validation.

    Args:
        lat: Center latitude
        lng: Center longitude
        bbox: [minLng, minLat, maxLng, maxLat]
        country: ISO country code (auto-detected if None)
        progress_callback: Optional function(step, detail) for progress updates

    Returns:
        {sources_found, sources_added, articles_fetched, errors, details}
    """
    def update(step, detail):
        log.info("[%s] %s", step, detail)
        if progress_callback:
            progress_callback(step, detail)

    # Detect country if not provided
    if not country:
        country = _detect_country_from_coords(lat, lng)

    country_name = _get_country_name(country) if country else "this region"

    # Get existing feed URLs to avoid duplicates
    existing_urls = set()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT feed_url FROM news_sources")
        existing_urls = {r["feed_url"] for r in cur.fetchall()}

    # Also check feeds.json
    try:
        with FEEDS_FILE.open() as f:
            for fd in json.load(f).get("feeds", []):
                existing_urls.add(fd.get("feed_url", ""))
    except Exception:
        pass

    update("search", f"Searching the internet for news sources in {country_name}...")

    # Build search queries
    queries = [
        f"{country_name} news RSS feed",
        f"{country_name} newspaper RSS",
    ]
    if bbox:
        # Try to get city names from the bbox
        try:
            center_text = f"{lat},{lng}"
            stats = cities_text.stats(center_text)
            if stats and stats.get("primary"):
                city_name = stats["primary"].get("name", "")
                if city_name:
                    queries.insert(0, f"{city_name} news RSS feed")
        except Exception:
            pass

    # Search for domains
    all_domains = []
    for query in queries:
        update("search", f"Searching: {query}")
        domains = _search_web_for_news(query)
        all_domains.extend(domains)
        time.sleep(1)  # Be polite to search engine

    # Dedupe domains
    unique_domains = list(dict.fromkeys(all_domains))[:20]
    update("search", f"Found {len(unique_domains)} potential news domains")

    # Probe domains for RSS feeds
    new_sources = []
    for i, domain in enumerate(unique_domains):
        update("probe", f"Checking {domain} for RSS feeds ({i+1}/{len(unique_domains)})...")
        feeds = _probe_domain_for_feeds(domain)
        for feed in feeds:
            if feed["feed_url"] not in existing_urls:
                feed["country"] = country
                feed["language"] = "en"
                feed["region"] = _get_region(country)
                new_sources.append(feed)
                existing_urls.add(feed["feed_url"])

    update("found", f"Found {len(new_sources)} new RSS sources")

    # Add sources to database
    added = 0
    for src in new_sources:
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
                    VALUES (%s, %s, %s, %s, %s, 'rss', TRUE)
                    ON CONFLICT (feed_url) DO NOTHING
                    RETURNING id
                """, (src["name"], src["feed_url"], src.get("country"),
                      src.get("language", "en"), src.get("region", "global")))
                row = cur.fetchone()
                if row:
                    added += 1
                    src["id"] = row["id"]
                    log.info("Added source: %s (%s)", src["name"], src["feed_url"])
        except Exception as e:
            log.debug("Failed to add source %s: %s", src["name"], e)

    update("added", f"Added {added} new sources to database")

    # Immediately fetch articles from new sources
    articles_fetched = 0
    if added > 0:
        update("fetch", f"Fetching articles from {added} new sources...")
        for src in new_sources:
            if not src.get("id"):
                continue
            try:
                articles = _fetch_source_articles(src["feed_url"])
                if articles:
                    inserted = _insert_articles(src["id"], articles)
                    articles_fetched += inserted
                    if inserted > 0:
                        update("fetch", f"Fetched {inserted} articles from {src['name']}")
            except Exception as e:
                log.debug("Failed to fetch from %s: %s", src["name"], e)

    update("done", f"Complete: {added} sources added, {articles_fetched} articles fetched")

    return {
        "sources_found": len(new_sources),
        "sources_added": added,
        "articles_fetched": articles_fetched,
        "sources": new_sources[:20],
        "country": country,
        "country_name": country_name,
    }


def _get_region(country_code: str | None) -> str:
    """Get region name from country code."""
    regions = {
        "IN": "south-asia", "PK": "south-asia", "BD": "south-asia", "LK": "south-asia",
        "NP": "south-asia", "AF": "south-asia",
        "ID": "southeast-asia", "PH": "southeast-asia", "TH": "southeast-asia",
        "VN": "southeast-asia", "MY": "southeast-asia", "SG": "southeast-asia",
        "MM": "southeast-asia", "KH": "southeast-asia",
        "JP": "east-asia", "KR": "east-asia", "CN": "east-asia", "TW": "east-asia",
        "AU": "oceania", "NZ": "oceania",
        "DE": "europe", "FR": "europe", "GB": "europe", "ES": "europe",
        "IT": "europe", "NL": "europe", "PL": "europe", "UA": "europe",
        "TR": "eurasia", "RU": "eurasia",
        "BR": "south-america", "AR": "south-america", "CO": "south-america",
        "MX": "central-america",
        "CA": "americas", "US": "americas",
        "NG": "west-africa", "GH": "west-africa",
        "KE": "east-africa", "ET": "east-africa", "TZ": "east-africa",
        "ZA": "southern-africa",
        "EG": "north-africa", "MA": "north-africa",
        "IR": "middle-east", "IQ": "middle-east", "IL": "middle-east",
        "SA": "middle-east", "AE": "middle-east",
    }
    return regions.get(country_code, "global")


def _fetch_source_articles(feed_url: str, limit: int = 20) -> list[dict]:
    """Fetch articles from an RSS feed."""
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(feed_url, headers={"User-Agent": USER_AGENT})
            if resp.status_code >= 400:
                return []

            parsed = feedparser.parse(resp.content)
            articles = []
            for entry in parsed.entries[:limit]:
                url = entry.get("link") or entry.get("id", "")
                if not url:
                    continue

                # Extract body
                body = ""
                for key in ("summary", "description", "content"):
                    val = entry.get(key)
                    if isinstance(val, str):
                        body = val
                        break
                    elif isinstance(val, list) and val:
                        body = val[0].get("value", "")
                        break

                # Strip HTML
                body = re.sub(r'<[^>]+>', ' ', body).strip()

                articles.append({
                    "url": url,
                    "title": (entry.get("title") or "").strip()[:500],
                    "body": body[:16000],
                    "published_at": _parse_date(entry),
                })

            return articles
    except Exception as e:
        log.debug("Failed to fetch %s: %s", feed_url, e)
        return []


def _parse_date(entry) -> str | None:
    """Parse publication date from feed entry."""
    import calendar as _calendar
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        t = entry.get(key)
        if t:
            try:
                # UTC struct from feedparser — timegm, NOT mktime (see fetch.py:183)
                return datetime.fromtimestamp(_calendar.timegm(t), tz=timezone.utc).isoformat()
            except Exception:
                continue
    return None


def _insert_articles(source_id: int, articles: list[dict]) -> int:
    """Insert articles into database. Returns count of new articles."""
    from datetime import datetime, timezone

    inserted = 0
    with connect() as conn, conn.cursor() as cur:
        for art in articles:
            try:
                cur.execute("""
                    INSERT INTO news_articles (source_id, url, title, body, published_at, status)
                    VALUES (%s, %s, %s, %s, %s, 'pending')
                    ON CONFLICT (url, source_id) DO NOTHING
                    RETURNING id, source_id, title, url, published_at
                """, (
                    source_id,
                    art["url"],
                    art["title"],
                    art["body"],
                    art.get("published_at"),
                ))
                row = cur.fetchone()
                if row is not None:
                    inserted += 1
                    # Best-effort SSE notify (see worker/notify.py).
                    try:
                        from .notify import notify_article_created
                        if isinstance(row, dict):
                            notify_article_created(row)
                        else:
                            notify_article_created({
                                "id": row[0],
                                "source_id": row[1],
                                "title": row[2],
                                "url": row[3],
                                "published_at": row[4],
                                "status": "pending",
                            })
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:
                continue

    return inserted
