"""Global News Source Builder — discovers and adds news sources based on world population.

This module:
  1. Maintains a database of the world's most populous countries
  2. Discovers RSS feeds for each country using AI and web search
  3. Validates feeds and adds them to the registry
  4. Prioritizes sources based on population and news importance

Usage:
  python -m worker.build_global_sources --discover     # Discover new sources
  python -m worker.build_global_sources --validate      # Validate existing sources
  python -m worker.build_global_sources --stats         # Show coverage stats
"""

import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from .db import connect
from . import explore_region

log = logging.getLogger("xyzo.global_sources")

FEEDS_FILE = Path(__file__).parent / "feeds.json"
AI_ENDPOINT = "http://192.168.1.3:8888/chat/stream"
SAFE_HEADERS = {"X-MCP-Safe": "true"}

# Top 50 most populous countries with their approximate populations
# This drives the priority for source discovery
COUNTRIES_BY_POPULATION = [
    # (country_code, country_name, population_millions, region, language)
    ("CN", "China", 1425, "east-asia", "zh"),
    ("IN", "India", 1428, "south-asia", "en"),
    ("US", "United States", 340, "americas", "en"),
    ("ID", "Indonesia", 277, "southeast-asia", "id"),
    ("PK", "Pakistan", 230, "south-asia", "en"),
    ("BR", "Brazil", 216, "south-america", "pt"),
    ("NG", "Nigeria", 223, "west-africa", "en"),
    ("BD", "Bangladesh", 173, "south-asia", "bn"),
    ("RU", "Russia", 144, "eurasia", "ru"),
    ("MX", "Mexico", 128, "americas", "es"),
    ("JP", "Japan", 125, "east-asia", "ja"),
    ("ET", "Ethiopia", 126, "east-africa", "am"),
    ("PH", "Philippines", 117, "southeast-asia", "en"),
    ("EG", "Egypt", 112, "north-africa", "ar"),
    ("VN", "Vietnam", 100, "southeast-asia", "vi"),
    ("CD", "DR Congo", 102, "central-africa", "fr"),
    ("TR", "Turkey", 85, "middle-east", "tr"),
    ("IR", "Iran", 88, "middle-east", "fa"),
    ("DE", "Germany", 84, "europe", "de"),
    ("TH", "Thailand", 72, "southeast-asia", "th"),
    ("GB", "United Kingdom", 68, "europe", "en"),
    ("FR", "France", 68, "europe", "fr"),
    ("IT", "Italy", 59, "europe", "it"),
    ("TZ", "Tanzania", 65, "east-africa", "en"),
    ("ZA", "South Africa", 60, "southern-africa", "en"),
    ("MM", "Myanmar", 55, "southeast-asia", "my"),
    ("KE", "Kenya", 55, "east-africa", "en"),
    ("KR", "South Korea", 52, "east-asia", "ko"),
    ("CO", "Colombia", 52, "south-america", "es"),
    ("ES", "Spain", 48, "europe", "es"),
    ("UA", "Ukraine", 44, "europe", "uk"),
    ("AR", "Argentina", 46, "south-america", "es"),
    ("DZ", "Algeria", 45, "north-africa", "ar"),
    ("SD", "Sudan", 47, "north-africa", "ar"),
    ("IQ", "Iraq", 43, "middle-east", "ar"),
    ("AF", "Afghanistan", 41, "south-asia", "ps"),
    ("PL", "Poland", 38, "europe", "pl"),
    ("CA", "Canada", 39, "americas", "en"),
    ("MA", "Morocco", 37, "north-africa", "ar"),
    ("SA", "Saudi Arabia", 36, "middle-east", "ar"),
    ("UZ", "Uzbekistan", 35, "central-asia", "uz"),
    ("PE", "Peru", 34, "south-america", "es"),
    ("AO", "Angola", 35, "central-africa", "pt"),
    ("MZ", "Mozambique", 33, "southern-africa", "pt"),
    ("GH", "Ghana", 33, "west-africa", "en"),
    ("NP", "Nepal", 30, "south-asia", "ne"),
    ("MY", "Malaysia", 33, "southeast-asia", "ms"),
    ("VE", "Venezuela", 28, "south-america", "es"),
    ("CM", "Cameroon", 28, "central-africa", "fr"),
    ("AU", "Australia", 26, "oceania", "en"),
]

# Known reliable RSS feeds for major countries
# These are pre-validated and ready to add
KNOWN_SOURCES = {
    "CN": [
        {"name": "China Daily", "feed_url": "https://www.chinadaily.com.cn/rss/world_rss.xml", "language": "en"},
        {"name": "South China Morning Post", "feed_url": "https://www.scmp.com/rss/91/feed", "language": "en"},
        {"name": "Xinhua English", "feed_url": "http://www.xinhuanet.com/english/rss/worldrss.xml", "language": "en"},
    ],
    "IN": [
        {"name": "Times of India", "feed_url": "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "language": "en"},
        {"name": "The Hindu", "feed_url": "https://www.thehindu.com/news/international/feeder/default.rss", "language": "en"},
        {"name": "NDTV", "feed_url": "https://feeds.feedburner.com/ndtvnews-world-news", "language": "en"},
        {"name": "Indian Express", "feed_url": "https://indianexpress.com/section/world/feed/", "language": "en"},
        {"name": "Hindustan Times", "feed_url": "https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml", "language": "en"},
    ],
    "ID": [
        {"name": "Jakarta Post", "feed_url": "https://www.thejakartapost.com/feed", "language": "en"},
        {"name": "Tempo English", "feed_url": "https://en.tempo.co/rss", "language": "en"},
        {"name": "Antara News", "feed_url": "https://en.antaranews.com/rss/world.xml", "language": "en"},
    ],
    "PK": [
        {"name": "Dawn", "feed_url": "https://www.dawn.com/feeds/home/", "language": "en"},
        {"name": "The News International", "feed_url": "https://www.thenews.com.pk/rss/1/1", "language": "en"},
        {"name": "Express Tribune", "feed_url": "https://tribune.com.pk/feed/home", "language": "en"},
    ],
    "BR": [
        {"name": "Folha de S.Paulo", "feed_url": "https://feeds.folha.uol.com.br/mundo/rss091.xml", "language": "pt"},
        {"name": "Rio Times", "feed_url": "https://www.riotimesonline.com/feed/", "language": "en"},
    ],
    "NG": [
        {"name": "Premium Times", "feed_url": "https://www.premiumtimesng.com/feed", "language": "en"},
        {"name": "Vanguard Nigeria", "feed_url": "https://www.vanguardngr.com/feed/", "language": "en"},
        {"name": "Punch Nigeria", "feed_url": "https://punchng.com/feed/", "language": "en"},
        {"name": "The Cable", "feed_url": "https://www.thecable.ng/feed", "language": "en"},
    ],
    "BD": [
        {"name": "The Daily Star", "feed_url": "https://www.thedailystar.net/frontpage/rss.xml", "language": "en"},
        {"name": "Prothom Alo English", "feed_url": "https://en.prothomalo.com/feed", "language": "en"},
    ],
    "RU": [
        {"name": "Moscow Times", "feed_url": "https://www.themoscowtimes.com/rss/news", "language": "en"},
        {"name": "TASS", "feed_url": "https://tass.com/rss/v2.xml", "language": "en"},
    ],
    "MX": [
        {"name": "Mexico News Daily", "feed_url": "https://mexiconewsdaily.com/feed/", "language": "en"},
        {"name": "El Universal", "feed_url": "https://www.eluniversal.com.mx/rss.xml", "language": "es"},
    ],
    "JP": [
        {"name": "Japan Times", "feed_url": "https://www.japantimes.co.jp/feed/", "language": "en"},
        {"name": "NHK World", "feed_url": "https://www3.nhk.or.jp/nhkworld/en/news/feeds/", "language": "en"},
        {"name": "Mainichi", "feed_url": "https://mainichi.jp/english/rss.xml", "language": "en"},
    ],
    "PH": [
        {"name": "Rappler", "feed_url": "https://www.rappler.com/rss/", "language": "en"},
        {"name": "Inquirer", "feed_url": "https://newsinfo.inquirer.net/feed", "language": "en"},
        {"name": "Philippine Star", "feed_url": "https://www.philstar.com/rss/headlines", "language": "en"},
    ],
    "EG": [
        {"name": "Al-Ahram", "feed_url": "https://english.ahram.org.eg/RSS.aspx", "language": "en"},
        {"name": "Egypt Independent", "feed_url": "https://egyptindependent.com/feed/", "language": "en"},
    ],
    "VN": [
        {"name": "VnExpress", "feed_url": "https://e.vnexpress.net/rss/rss.xml", "language": "en"},
        {"name": "Vietnam News", "feed_url": "https://vietnamnews.vn/rss/world.rss", "language": "en"},
    ],
    "TR": [
        {"name": "Daily Sabah", "feed_url": "https://www.dailysabah.com/rssFeed/world", "language": "en"},
        {"name": "Hurriyet Daily News", "feed_url": "https://www.hurriyetdailynews.com/rss", "language": "en"},
        {"name": "TRT World", "feed_url": "https://www.trtworld.com/rss", "language": "en"},
    ],
    "IR": [
        {"name": "Tehran Times", "feed_url": "https://www.tehrantimes.com/rss", "language": "en"},
        {"name": "Press TV", "feed_url": "https://www.presstv.ir/RSS", "language": "en"},
        {"name": "IRNA English", "feed_url": "https://en.irna.ir/rss", "language": "en"},
    ],
    "TH": [
        {"name": "Bangkok Post", "feed_url": "https://www.bangkokpost.com/rss/data/topstories.xml", "language": "en"},
        {"name": "The Nation Thailand", "feed_url": "https://www.nationthailand.com/rss", "language": "en"},
    ],
    "ET": [
        {"name": "Ethiopian Monitor", "feed_url": "https://ethiopianmonitor.com/feed/", "language": "en"},
        {"name": "Addis Standard", "feed_url": "https://addisstandard.com/feed/", "language": "en"},
    ],
    "DE": [
        {"name": "Deutsche Welle", "feed_url": "https://rss.dw.com/rdf/rss-en-top", "language": "en"},
        {"name": "Der Spiegel", "feed_url": "https://www.spiegel.de/international/index.rss", "language": "en"},
    ],
    "FR": [
        {"name": "France 24", "feed_url": "https://www.france24.com/en/rss", "language": "en"},
        {"name": "RFI", "feed_url": "https://www.rfi.fr/en/international/rss", "language": "en"},
        {"name": "Le Monde", "feed_url": "https://www.lemonde.fr/en/rss/une.xml", "language": "en"},
    ],
    "IT": [
        {"name": "ANSA English", "feed_url": "https://www.ansamed.info/ansamed/en/rss.xml", "language": "en"},
    ],
    "ES": [
        {"name": "El Pais English", "feed_url": "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada", "language": "en"},
    ],
    "SA": [
        {"name": "Arab News", "feed_url": "https://www.arabnews.com/rss.xml", "language": "en"},
        {"name": "Saudi Gazette", "feed_url": "https://www.saudigazette.com.sa/rss", "language": "en"},
    ],
    "KR": [
        {"name": "Korea Times", "feed_url": "https://www.koreatimes.co.kr/www/rss/rss.xml", "language": "en"},
        {"name": "Yonhap News", "feed_url": "https://en.yna.co.kr/RSS/news.xml", "language": "en"},
    ],
    "CO": [
        {"name": "Colombia Reports", "feed_url": "https://colombiareports.com/feed/", "language": "en"},
    ],
    "KE": [
        {"name": "The EastAfrican", "feed_url": "https://www.theeastafrican.co.ke/service/rss/meta/2558/feed.rss", "language": "en"},
        {"name": "Daily Nation", "feed_url": "https://www.nation.co.ke/kenya/news/rss", "language": "en"},
    ],
    "ZA": [
        {"name": "Mail & Guardian", "feed_url": "https://mg.co.za/feed/", "language": "en"},
        {"name": "Daily Maverick", "feed_url": "https://www.dailymaverick.co.za/feed/", "language": "en"},
    ],
    "GH": [
        {"name": "Ghana Web", "feed_url": "https://www.ghanaweb.com/GhanaHomePage/rss/", "language": "en"},
    ],
    "MY": [
        {"name": "The Star Malaysia", "feed_url": "https://www.thestar.com.my/rss/News/", "language": "en"},
        {"name": "Malay Mail", "feed_url": "https://www.malaymail.com/feed", "language": "en"},
    ],
    "AU": [
        {"name": "ABC News Australia", "feed_url": "https://www.abc.net.au/news/feed/51120/rss.xml", "language": "en"},
        {"name": "Sydney Morning Herald", "feed_url": "https://www.smh.com.au/rss/feed.xml", "language": "en"},
    ],
    "CA": [
        {"name": "Globe and Mail", "feed_url": "https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/world/", "language": "en"},
        {"name": "CBC News", "feed_url": "https://www.cbc.ca/cmlink/rss-world", "language": "en"},
    ],
    "MM": [
        {"name": "The Irrawaddy", "feed_url": "https://www.irrawaddy.com/feed", "language": "en"},
        {"name": "Myanmar Now", "feed_url": "https://myanmar-now.org/en/feed", "language": "en"},
    ],
    "SD": [
        {"name": "Sudan Tribune", "feed_url": "https://www.sudantribune.com/spip.php?flux", "language": "en"},
    ],
    "IQ": [
        {"name": "Iraqi News", "feed_url": "https://www.iraqinews.com/feed/", "language": "en"},
        {"name": "Rudaw English", "feed_url": "https://www.rudaw.net/english/rss", "language": "en"},
    ],
    "AF": [
        {"name": "Tolo News", "feed_url": "https://tolonews.com/en/rss.xml", "language": "en"},
        {"name": "Pajhwok Afghan News", "feed_url": "https://pajhwok.com/feed/", "language": "en"},
    ],
    "NP": [
        {"name": "Kathmandu Post", "feed_url": "https://kathmandupost.com/rss", "language": "en"},
        {"name": "The Himalayan Times", "feed_url": "https://thehimalayantimes.com/feed/", "language": "en"},
    ],
    "VE": [
        {"name": "Caracas Chronicles", "feed_url": "https://caracaschronicles.com/feed/", "language": "en"},
    ],
    "CM": [
        {"name": "Cameroon Tribune", "feed_url": "https://www.cameroon-tribune.cm/rss", "language": "en"},
    ],
    "MZ": [
        {"name": "Mozambique News", "feed_url": "https://www.moznews.com/feed", "language": "en"},
    ],
    "AO": [
        {"name": "Angola Press", "feed_url": "https://www.angop.ao/angola/en_us/rss.xml", "language": "en"},
    ],
    "UZ": [
        {"name": "UzA", "feed_url": "https://uza.uz/en/rss", "language": "en"},
    ],
    "TZ": [
        {"name": "The Citizen", "feed_url": "https://www.thecitizen.co.tz/rss", "language": "en"},
    ],
    "CD": [
        {"name": "Radio Okapi", "feed_url": "https://www.radiookapi.net/rss", "language": "fr"},
    ],
    "DZ": [
        {"name": "Algeria Press Service", "feed_url": "https://www.aps.dz/en/rss", "language": "en"},
    ],
    "MA": [
        {"name": "Morocco World News", "feed_url": "https://www.moroccoworldnews.com/feed", "language": "en"},
    ],
    "PL": [
        {"name": "Notes from Poland", "feed_url": "https://notesfrompoland.com/feed/", "language": "en"},
    ],
    "UA": [
        {"name": "Kyiv Independent", "feed_url": "https://kyivindependent.com/feed/", "language": "en"},
        {"name": "Ukrainska Pravda", "feed_url": "https://www.pravda.com.ua/eng/rss/", "language": "en"},
    ],
}


def get_coverage_stats() -> dict:
    """Get current coverage statistics by country."""
    with connect() as conn, conn.cursor() as cur:
        # Sources by country
        cur.execute("""
            SELECT country, COUNT(*) as total,
                   SUM(CASE WHEN active THEN 1 ELSE 0 END) as active
            FROM news_sources
            GROUP BY country
            ORDER BY total DESC
        """)
        sources_by_country = {row["country"]: {"total": row["total"], "active": row["active"]}
                             for row in cur.fetchall()}

        # Articles by country (from locations)
        cur.execute("""
            SELECT l.country, COUNT(*) as articles
            FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE l.country IS NOT NULL
            GROUP BY l.country
            ORDER BY articles DESC
        """)
        articles_by_country = {row["country"]: row["articles"] for row in cur.fetchall()}

    # Calculate coverage gaps
    coverage = []
    for cc, name, pop, region, lang in COUNTRIES_BY_POPULATION:
        src = sources_by_country.get(cc, {"total": 0, "active": 0})
        arts = articles_by_country.get(cc, 0)
        # Also check alternative country name formats
        for alt_key in [name, name.upper(), name.lower()]:
            if alt_key in articles_by_country:
                arts = max(arts, articles_by_country[alt_key])

        coverage.append({
            "country_code": cc,
            "country_name": name,
            "population_millions": pop,
            "region": region,
            "language": lang,
            "sources_total": src["total"],
            "sources_active": src["active"],
            "articles": arts,
            "coverage_score": round((src["active"] * 10 + arts) / pop * 100, 2),
        })

    # Sort by coverage gap (population / coverage)
    coverage.sort(key=lambda x: x["population_millions"] / max(x["sources_active"], 0.1), reverse=True)

    return {
        "countries": coverage,
        "total_sources": sum(s["total"] for s in sources_by_country.values()),
        "total_active": sum(s["active"] for s in sources_by_country.values()),
        "countries_with_sources": len(sources_by_country),
        "countries_without_sources": len(COUNTRIES_BY_POPULATION) - len(
            set(c[0] for c in COUNTRIES_BY_POPULATION) & set(sources_by_country.keys())
        ),
    }


def add_known_sources(countries: list[str] | None = None, dry_run: bool = False) -> dict:
    """Add known RSS sources for specified countries (or all)."""
    to_add = []
    target_countries = countries or list(KNOWN_SOURCES.keys())

    for cc in target_countries:
        if cc not in KNOWN_SOURCES:
            continue
        for src in KNOWN_SOURCES[cc]:
            # Find country info
            country_info = next((c for c in COUNTRIES_BY_POPULATION if c[0] == cc), None)
            region = country_info[3] if country_info else "unknown"

            to_add.append({
                "name": src["name"],
                "feed_url": src["feed_url"],
                "country": cc,
                "language": src.get("language", "en"),
                "region": region,
            })

    if dry_run:
        return {"would_add": len(to_add), "sources": to_add}

    added = 0
    skipped = 0
    errors = 0

    with connect() as conn, conn.cursor() as cur:
        for src in to_add:
            try:
                cur.execute("""
                    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
                    VALUES (%s, %s, %s, %s, %s, 'rss', TRUE)
                    ON CONFLICT (feed_url) DO NOTHING
                    RETURNING id
                """, (src["name"], src["feed_url"], src["country"], src["language"], src["region"]))
                if cur.fetchone():
                    added += 1
                else:
                    skipped += 1
            except Exception as e:
                log.warning("Failed to add %s: %s", src["name"], e)
                errors += 1

    # Also update feeds.json
    _update_feeds_json(to_add)

    return {"added": added, "skipped": skipped, "errors": errors, "total": len(to_add)}


def _update_feeds_json(new_sources: list[dict]) -> None:
    """Update feeds.json with new sources."""
    try:
        with FEEDS_FILE.open() as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {"feeds": []}

    existing_urls = {f["feed_url"] for f in data["feeds"]}

    for src in new_sources:
        if src["feed_url"] not in existing_urls:
            data["feeds"].append({
                "name": src["name"],
                "feed_url": src["feed_url"],
                "country": src["country"],
                "language": src["language"],
                "region": src["region"],
                "enabled": True,
            })
            existing_urls.add(src["feed_url"])

    with FEEDS_FILE.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def discover_sources_with_ai(country_code: str, country_name: str) -> list[dict]:
    """Use AI to discover news sources for a country."""
    prompt = f"""Find RSS news feeds for {country_name} ({country_code}).

I need REAL, WORKING RSS feed URLs for major news outlets in this country.

Requirements:
- Must be English-language feeds (or bilingual with English)
- Must be actual RSS/Atom feed URLs (ending in /feed, /rss, .xml, etc.)
- Focus on: national newspapers, wire services, major broadcasters
- Return 3-5 sources maximum

Return ONLY a JSON array, no other text:
[
  {{"name": "Outlet Name", "feed_url": "https://example.com/rss", "language": "en"}}
]

Country: {country_name}
ISO Code: {country_code}"""

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                AI_ENDPOINT,
                json={"message": prompt, "stream": False},
                headers={**SAFE_HEADERS, "Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()

        # Extract JSON from response
        text = data.get("response", "") or data.get("message", "")
        import re
        matches = re.findall(r'\[.*?\]', text, re.DOTALL)
        for match in matches:
            try:
                sources = json.loads(match)
                if isinstance(sources, list):
                    return [s for s in sources if s.get("feed_url") and s.get("name")]
            except json.JSONDecodeError:
                continue

    except Exception as e:
        log.warning("AI discovery failed for %s: %s", country_code, e)

    return []


def run_discovery(countries: list[str] | None = None, limit: int = 10) -> dict:
    """Run source discovery for countries with poor coverage."""
    stats = get_coverage_stats()

    # Find countries that need more sources
    needs_sources = []
    for c in stats["countries"]:
        if countries and c["country_code"] not in countries:
            continue
        if c["sources_active"] < 2 and c["population_millions"] > 20:
            needs_sources.append(c)

    # Sort by population (biggest gaps first)
    needs_sources.sort(key=lambda x: x["population_millions"], reverse=True)
    needs_sources = needs_sources[:limit]

    results = []
    for country in needs_sources:
        cc = country["country_code"]
        name = country["country_name"]

        log.info("Discovering sources for %s (%s)...", name, cc)

        # Try known sources first
        if cc in KNOWN_SOURCES:
            added = add_known_sources([cc])
            results.append({
                "country": name,
                "code": cc,
                "method": "known",
                **added,
            })
            continue

        # Try AI discovery — but check the breaker first so a downed AI
        # doesn't make us hang for 30s per country.
        try:
            from .extract import _ai_call_allowed
            if not _ai_call_allowed():
                log.warning("AI breaker open — using non-AI seed for %s", cc)
                ai_sources = []
            else:
                ai_sources = discover_sources_with_ai(cc, name)
        except ImportError:
            ai_sources = discover_sources_with_ai(cc, name)
        if ai_sources:
            # Validate and add
            validated = []
            for src in ai_sources:
                validation = explore_region.validate_rss_feed(src["feed_url"])
                if validation["valid"]:
                    src["country"] = cc
                    src["region"] = next((c[3] for c in COUNTRIES_BY_POPULATION if c[0] == cc), "unknown")
                    validated.append(src)

            if validated:
                _update_feeds_json(validated)
                with connect() as conn, conn.cursor() as cur:
                    for src in validated:
                        cur.execute("""
                            INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
                            VALUES (%s, %s, %s, %s, %s, 'rss', TRUE)
                            ON CONFLICT (feed_url) DO NOTHING
                        """, (src["name"], src["feed_url"], cc, src.get("language", "en"), src.get("region", "unknown")))

                results.append({
                    "country": name,
                    "code": cc,
                    "method": "ai",
                    **({"added": len(validated)} if validated else {}),
                })
                continue

        # Non-AI fallback: enumerate the country's major cities so an
        # admin has a concrete list to research manually. Records
        # nothing in DB — just informs the operator.
        seed_cities = _seed_cities_for_country(cc)
        results.append({
            "country": name,
            "code": cc,
            "method": "seed",
            "cities": seed_cities,
            "message": (
                "AI unavailable and no curated sources. Above are the "
                "country's major cities — research RSS feeds for outlets "
                "headquartered in these."
            ) if seed_cities else "AI unavailable; no curated sources.",
        })

        time.sleep(2)  # Rate limit

    return {"discovered": len(results), "results": results}


def _seed_cities_for_country(cc: str) -> list[dict]:
    """Return major cities (population ≥ 500k) for a country code.

    Used as a non-AI seed so the admin knows what to research when AI
    is unavailable. Read-only — does not insert into feeds.json.
    """
    try:
        from .db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT name, country_code, population, lat, lng
                FROM world_cities
                WHERE country_code = %s AND population >= 500000
                ORDER BY population DESC
                LIMIT 10
            """, (cc.upper(),))
            rows = cur.fetchall()
        return [
            {"name": r["name"], "country": r["country_code"],
             "population": int(r["population"] or 0),
             "lat": float(r["lat"]), "lng": float(r["lng"])}
            for r in rows
        ]
    except Exception as e:
        log.warning("_seed_cities_for_country(%s) failed: %s", cc, e)
        return []


# CLI entry point
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Global news source builder")
    parser.add_argument("--stats", action="store_true", help="Show coverage statistics")
    parser.add_argument("--add-known", action="store_true", help="Add known sources for all countries")
    parser.add_argument("--discover", action="store_true", help="Discover new sources using AI")
    parser.add_argument("--countries", nargs="+", help="Target specific country codes")
    parser.add_argument("--limit", type=int, default=10, help="Max countries to discover")
    parser.add_argument("--dry-run", action="store_true", help="Don't actually add sources")
    args = parser.parse_args()

    if args.stats:
        stats = get_coverage_stats()
        print("\n=== Global News Coverage Statistics ===\n")
        print(f"Total sources: {stats['total_sources']} ({stats['total_active']} active)")
        print(f"Countries with sources: {stats['countries_with_sources']}")
        print(f"Countries without sources: {stats['countries_without_sources']}")
        print("\n=== Coverage Gaps (Top 20) ===\n")
        print(f"{'Country':<25} {'Pop (M)':<10} {'Sources':<10} {'Articles':<10} {'Score':<10}")
        print("-" * 65)
        for c in stats["countries"][:20]:
            print(f"{c['country_name']:<25} {c['population_millions']:<10} {c['sources_active']:<10} {c['articles']:<10} {c['coverage_score']:<10}")

    elif args.add_known:
        result = add_known_sources(args.countries, args.dry_run)
        if args.dry_run:
            print(f"\nWould add {result['would_add']} sources:")
            for s in result["sources"]:
                print(f"  - {s['name']} ({s['country']})")
        else:
            print(f"\nAdded: {result['added']}, Skipped: {result['skipped']}, Errors: {result['errors']}")

    elif args.discover:
        result = run_discovery(args.countries, args.limit)
        print(f"\nDiscovered sources for {result['discovered']} countries:")
        for r in result["results"]:
            print(f"  {r['country']} ({r['code']}): +{r.get('added', 0)} sources via {r['method']}")

    else:
        parser.print_help()
