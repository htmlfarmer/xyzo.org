"""Automated news source discovery — finds RSS feeds on the internet.

Strategies (tried in order, first hit wins per source):
  1. Common URL patterns — probe /feed, /rss, /rss.xml etc. on known domains
  2. Web search — scrape search results for "site:example.com RSS feed"
  3. RSS directories — feedly.com, opml.net, rss-bridge instances
  4. AI discovery — ask Gemma-4 for feeds matching a query

Usage:
    from worker.source_discovery import discover_sources
    results = discover_sources("Korean news", country="KR")
    # → [{name, feed_url, country, language, region, description, strategy, valid}]

All results are de-duped by feed_url and validated (HTTP GET + feedparser).
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote_plus, urlparse

import feedparser
import httpx

from .db import connect

log = logging.getLogger("xyzo.source_discovery")

USER_AGENT = "xyzo-source-finder/0.1 (https://xyzo.org; contact@xyzo.org)"
FEEDS_FILE = Path(__file__).parent / "feeds.json"
SAFE_HEADERS = {"X-MCP-Safe": "true"}

# Common RSS/Atom feed URL patterns to probe
FEED_PATHS = [
    "/feed",
    "/rss",
    "/rss.xml",
    "/atom.xml",
    "/feed.xml",
    "/feeds/posts/default",  # Blogger
    "/rss/feed",
    "/news/rss",
    "/rss/all.xml",
    "/en/rss",
    "/rss/top-stories",
    "/feed/rss",
    "/index.xml",
    "/blog/feed",
]

# Country name → ISO code mapping for search queries
_COUNTRY_NAMES = {
    # East Asia
    "korea": "KR", "south korea": "KR", "japan": "JP", "china": "CN",
    "taiwan": "TW", "hong kong": "HK", "mongolia": "MN",
    # South Asia
    "india": "IN", "pakistan": "PK", "bangladesh": "BD", "sri lanka": "LK",
    "nepal": "NP", "afghanistan": "AF", "bhutan": "BT", "maldives": "MV",
    # Southeast Asia
    "indonesia": "ID", "philippines": "PH", "thailand": "TH", "vietnam": "VN",
    "malaysia": "MY", "singapore": "SG", "myanmar": "MM", "cambodia": "KH",
    "laos": "LA", "brunei": "BN", "timor": "TL", "east timor": "TL",
    # Oceania
    "australia": "AU", "new zealand": "NZ", "fiji": "FJ", "fijian": "FJ",
    "papua new guinea": "PG", "png": "PG", "solomon islands": "SB", "solomon": "SB",
    "vanuatu": "VU", "samoa": "WS", "samoan": "WS", "tonga": "TO", "tongan": "TO",
    "cook islands": "CK", "kiribati": "KI", "tuvalu": "TV", "nauru": "NR",
    "micronesia": "FM", "marshall islands": "MH", "palau": "PW", "niue": "NU",
    "pacific islands": "FJ", "pacific island": "FJ", "pina": "FJ", "pacnews": "FJ",
    # Europe
    "germany": "DE", "france": "FR", "uk": "GB", "united kingdom": "GB",
    "britain": "GB", "spain": "ES", "italy": "IT", "netherlands": "NL",
    "poland": "PL", "ukraine": "UA", "russia": "RU", "turkey": "TR",
    "greece": "GR", "portugal": "PT", "ireland": "IE", "scotland": "GB",
    "wales": "GB", "sweden": "SE", "norway": "NO", "denmark": "DK",
    "finland": "FI", "iceland": "IS", "estonia": "EE", "latvia": "LV",
    "lithuania": "LT", "belarus": "BY", "moldova": "MD", "romania": "RO",
    "bulgaria": "BG", "serbia": "RS", "croatia": "HR", "slovenia": "SI",
    "slovakia": "SK", "hungary": "HU", "czech": "CZ", "austria": "AT",
    "switzerland": "CH", "belgium": "BE", "luxembourg": "LU", "monaco": "MC",
    "andorra": "AD", "liechtenstein": "LI", "san marino": "SM", "vatican": "VA",
    "malta": "MT", "cyprus": "CY",
    # Middle East
    "iran": "IR", "iraq": "IQ", "israel": "IL", "saudi": "SA",
    "uae": "AE", "qatar": "QA", "kuwait": "KW", "bahrain": "BH",
    "oman": "OM", "yemen": "YE", "jordan": "JO", "lebanon": "LB",
    "syria": "SY", "palestine": "PS", "pakistan": "PK",
    # Africa
    "nigeria": "NG", "kenya": "KE", "south africa": "ZA", "egypt": "EG",
    "ethiopia": "ET", "ghana": "GH", "tanzania": "TZ", "uganda": "UG",
    "morocco": "MA", "algeria": "DZ", "tunisia": "TN", "libya": "LY",
    "cameroon": "CM", "congo": "CD", "dr congo": "CD", "senegal": "SN",
    "ivory coast": "CI", "cote d'ivoire": "CI", "mali": "ML", "niger": "NE",
    "burkina faso": "BF", "chad": "TD", "sudan": "SD", "south sudan": "SS",
    "somalia": "SO", "eritrea": "ER", "djibouti": "DJ", "madagascar": "MG",
    "mozambique": "MZ", "zambia": "ZM", "zimbabwe": "ZW", "botswana": "BW",
    "namibia": "NA", "angola": "AO", "rwanda": "RW", "burundi": "BI",
    "lesotho": "LS", "eswatini": "SZ", "swaziland": "SZ", "mauritius": "MU",
    "seychelles": "SC", "comoros": "KM", "mauritania": "MR", "gambia": "GM",
    "guinea": "GN", "guinea-bissau": "GW", "sierra leone": "SL", "liberia": "LR",
    "togo": "TG", "benin": "BJ", "gabon": "GA", "equatorial guinea": "GQ",
    "central african republic": "CF", "republic of congo": "CG",
    # Americas
    "brazil": "BR", "argentina": "AR", "mexico": "MX", "colombia": "CO",
    "chile": "CL", "peru": "PE", "venezuela": "VE", "ecuador": "EC",
    "bolivia": "BO", "paraguay": "PY", "uruguay": "UY", "guyana": "GY",
    "suriname": "SR", "french guiana": "GF",
    "canada": "CA", "us": "US", "usa": "US", "united states": "US",
    "cuba": "CU", "jamaica": "JM", "haiti": "HT", "dominican republic": "DO",
    "trinidad": "TT", "trinidad and tobago": "TT", "bahamas": "BS",
    "barbados": "BB", "belize": "BZ", "costa rica": "CR", "panama": "PA",
    "el salvador": "SV", "guatemala": "GT", "honduras": "HN", "nicaragua": "NI",
    "puerto rico": "PR", "guam": "GU", "virgin islands": "VI",
    # Central Asia
    "kazakhstan": "KZ", "uzbekistan": "UZ", "tajikistan": "TJ",
    "kyrgyzstan": "KG", "turkmenistan": "TM", "georgia": "GE",
    "armenia": "AM", "azerbaijan": "AZ",
}

# Country → typical region tag
_COUNTRY_REGIONS = {
    # East Asia
    "KR": "east-asia", "JP": "east-asia", "CN": "east-asia", "TW": "east-asia",
    "HK": "east-asia", "MN": "east-asia",
    # South Asia
    "IN": "south-asia", "PK": "south-asia", "BD": "south-asia", "NP": "south-asia",
    "LK": "south-asia", "AF": "south-asia", "BT": "south-asia", "MV": "south-asia",
    # Southeast Asia
    "ID": "southeast-asia", "PH": "southeast-asia", "TH": "southeast-asia",
    "VN": "southeast-asia", "MY": "southeast-asia", "SG": "southeast-asia",
    "MM": "southeast-asia", "KH": "southeast-asia", "LA": "southeast-asia",
    "BN": "southeast-asia", "TL": "southeast-asia",
    # Oceania
    "AU": "oceania", "NZ": "oceania", "FJ": "oceania", "PG": "oceania",
    "SB": "oceania", "VU": "oceania", "WS": "oceania", "TO": "oceania",
    "KI": "oceania", "TV": "oceania", "NR": "oceania", "FM": "oceania",
    "MH": "oceania", "PW": "oceania", "CK": "oceania", "NU": "oceania",
    # Europe
    "DE": "europe", "FR": "europe", "GB": "europe", "ES": "europe",
    "IT": "europe", "NL": "europe", "PL": "europe", "UA": "europe",
    "TR": "eurasia", "RU": "eurasia", "GR": "europe", "PT": "europe",
    "IE": "europe", "SE": "europe", "NO": "europe", "DK": "europe",
    "FI": "europe", "IS": "europe", "EE": "europe", "LV": "europe",
    "LT": "europe", "BY": "europe", "MD": "europe", "RO": "europe",
    "BG": "europe", "RS": "europe", "HR": "europe", "SI": "europe",
    "SK": "europe", "HU": "europe", "CZ": "europe", "AT": "europe",
    "CH": "europe", "BE": "europe", "LU": "europe", "MC": "europe",
    "AD": "europe", "LI": "europe", "SM": "europe", "VA": "europe",
    "MT": "europe", "CY": "europe",
    # Middle East
    "IR": "middle-east", "IQ": "middle-east", "IL": "middle-east", "SA": "middle-east",
    "AE": "middle-east", "QA": "middle-east", "KW": "middle-east", "BH": "middle-east",
    "OM": "middle-east", "YE": "middle-east", "JO": "middle-east", "LB": "middle-east",
    "SY": "middle-east", "PS": "middle-east",
    # Americas
    "BR": "south-america", "AR": "south-america", "CO": "south-america",
    "CL": "south-america", "PE": "south-america", "VE": "south-america",
    "EC": "south-america", "BO": "south-america", "PY": "south-america",
    "UY": "south-america", "GY": "south-america", "SR": "south-america", "GF": "south-america",
    "MX": "central-america", "CU": "central-america", "JM": "caribbean",
    "HT": "caribbean", "DO": "caribbean", "TT": "caribbean", "BS": "caribbean",
    "BB": "caribbean", "BZ": "central-america", "CR": "central-america",
    "PA": "central-america", "SV": "central-america", "GT": "central-america",
    "HN": "central-america", "NI": "central-america", "PR": "caribbean",
    "CA": "americas", "US": "americas",
    # Africa
    "NG": "west-africa", "GH": "west-africa", "SN": "west-africa",
    "CI": "west-africa", "ML": "west-africa", "NE": "west-africa",
    "BF": "west-africa", "GM": "west-africa", "GN": "west-africa",
    "GW": "west-africa", "SL": "west-africa", "LR": "west-africa",
    "TG": "west-africa", "BJ": "west-africa", "GA": "central-africa",
    "GQ": "central-africa", "CG": "central-africa", "CF": "central-africa",
    "CM": "central-africa", "CD": "central-africa", "AO": "central-africa",
    "KE": "east-africa", "ET": "east-africa", "TZ": "east-africa",
    "UG": "east-africa", "RW": "east-africa", "BI": "east-africa",
    "SO": "east-africa", "ER": "east-africa", "DJ": "east-africa",
    "MZ": "southern-africa", "ZM": "southern-africa", "ZW": "southern-africa",
    "BW": "southern-africa", "NA": "southern-africa", "ZA": "southern-africa",
    "LS": "southern-africa", "SZ": "southern-africa", "MG": "east-africa",
    "MW": "east-africa", "MU": "east-africa", "SC": "east-africa",
    "KM": "east-africa", "MR": "west-africa",
    "EG": "north-africa", "LY": "north-africa", "TN": "north-africa",
    "DZ": "north-africa", "MA": "north-africa", "SD": "north-africa",
    "SS": "east-africa", "TD": "central-africa", "CM": "central-africa",
    # Central Asia
    "KZ": "central-asia", "UZ": "central-asia", "TJ": "central-asia",
    "KG": "central-asia", "TM": "central-asia", "GE": "caucasus",
    "AM": "caucasus", "AZ": "caucasus",
}

# Language → RSS/news search terms for multilingual discovery
LANGUAGE_SEARCH_TERMS = {
    "en": ["RSS feed", "news feed", "newspaper"],
    "es": ["noticias RSS", "fuente RSS", "periódico", "diario", "elmundo", "elpais"],
    "fr": ["flux RSS actualité", "journal", "presse", "lemonde", "lefigaro"],
    "de": ["nachrichten RSS", "zeitung", "nachrichten", "spiegel", "faz"],
    "pt": ["notícias RSS", "jornal", "folha", "globulo"],
    "ar": ["أخبار RSS", "صحافة", "جريدة", "الاخبار"],
    "zh": ["新闻 RSS", "订阅", "人民日报", "新华网"],
    "ja": ["ニュース RSS", "新聞", "読売", "朝日"],
    "ko": ["뉴스 RSS", "신문", "조선일보", "중앙일보"],
    "ru": ["новости RSS", "газета", "известия", "коммерсант"],
    "hi": ["समाचार RSS", "पत्र", "हिंदुस्तान"],
    "ur": ["خبریں RSS", "اخبار", "روزنامہ"],
    "bn": ["সংবাদ RSS", "পত্রিকা", "প্রতিকা"],
    "id": ["berita RSS", "surat kabar", "kompas"],
    "ms": ["berita RSS", "akhbar", "malaysian"],
    "th": ["ข่าว RSS", "หนังสือพิมพ์", "ไทยรัฐ"],
    "vi": ["tin tức RSS", "báo chí", "vietnam"],
    "tl": ["balita RSS", "palihan", "pilipino"],
    "tr": ["haber RSS", "gazete", "hurriyet", "sabah"],
    "fa": ["خبر RSS", "روزنامه", "ایران"],
    "he": ["חדשות RSS", "עיתון", "ידיעות"],
    "uk": ["новини RSS", "газета", "українська"],
    "pl": ["wiadomości RSS", "gazeta", "gazeta wyborcza"],
    "cs": ["zprávy RSS", "noviny", "lidovky"],
    "ro": ["știri RSS", "ziare", "evenimentul"],
    "hu": ["hírek RSS", "újság", "magyar"],
    "el": ["ειδήσεις RSS", "εφημεριδα", "καθημερινη"],
    "sv": ["nyheter RSS", "tidning", "dn"],
    "no": ["nyheter RSS", "avis", "nrk"],
    "da": ["nyheder RSS", "avis", "politiken"],
    "fi": ["uutiset RSS", "sanomalehti", "hs"],
    "nl": ["nieuws RSS", "krant", "telegraaf"],
    "sw": ["habari RSS", "gazeti", "taifa"],
    "yo": ["iwé RSS", "iọ̀rọ̀", "yoruba"],
    "ig": ["akụkọ RSS", "akwụkwọ", "igbo"],
    "ha": ["labarai RSS", "jarida", "hausa"],
    "zu": ["izindaba RSS", "iphephandaba", "zulu"],
    "xh": ["iindaba RSS", "iphephandaba", "xhosa"],
    "am": ["ዜና RSS", "ጋዜጣ", "ethiopian"],
    "om": ["Oromo news RSS", "gaazettii", "oromia"],
    "ti": ["ልዑል RSS", "ጋዜጣ", "eritrean"],
    "km": ["ព័ត៌មាន RSS", "កាសែត", "khmer"],
    "lo": ["ຂ່າວ RSS", "ໜັງສື", "lao"],
    "my": ["သတင်း RSS", "သတင်းစာ", "burmese"],
    "ne": ["समाचार RSS", "पत्रिका", "nepal"],
    "si": ["පුවත් RSS", "ජනපරමු", "sinhala"],
    "ta": ["செய்திகள் RSS", "இதழ்", "tamil"],
    "te": ["వార్తలు RSS", "పత్రిక", "telugu"],
    "kn": ["ಸುದ್ದಿ RSS", "ಪತ್ರಿಕೆ", "kannada"],
    "ml": ["വാർത്തകൾ RSS", "ദിനപത്രം", "malayalam"],
    "mr": ["बातम्या RSS", "वृत्तपत्र", "marathi"],
    "pa": ["ਖ਼ਬਰਾਂ RSS", "ਅਖ਼ਬਾਰ", "punjabi"],
    "gu": ["સમાચાર RSS", "અખબાર", "gujarati"],
    "sd": ["خبرون RSS", "اخبار", "sindhi"],
    "ps": ["خبرونه RSS", "ورځپاڼه", "pashto"],
    "ku": ["ھەواڵ RSS", "ڕۆژنامە", "kurdish"],
    "ckb": ["هەواڵ RSS", "ڕۆژنامە", "sorani"],
    "tg": ["ахбор RSS", "рӯзнома", "tajik"],
    "ky": ["жаңылык RSS", "гезит", "kyrgyz"],
    "uz": ["yangiliklar RSS", "gazeta", "uzbek"],
    "kk": ["жаңалықтар RSS", "газет", "kazakh"],
    "mn": ["мэдээ RSS", "сонин", "mongolian"],
    "ru": ["новости RSS", "газета", "izvestia"],
}


def _resolve_country(query: str) -> str | None:
    """Extract a country code from a free-text query."""
    q = query.lower().strip()
    # Direct ISO code
    if len(q) == 2 and q.upper() in _COUNTRY_REGIONS:
        return q.upper()
    # Country name lookup
    for name, code in _COUNTRY_NAMES.items():
        if name in q:
            return code
    return None


def _existing_feed_urls() -> set[str]:
    """Get all feed URLs already in the database."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT feed_url FROM news_sources")
        return {row["feed_url"] for row in cur.fetchall()}


def _load_feeds_json_urls() -> set[str]:
    """Get all feed URLs from feeds.json."""
    try:
        with FEEDS_FILE.open() as f:
            return {fd["feed_url"] for fd in json.load(f)["feeds"]}
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


# ── Strategy 1: Probe common URL patterns on a domain ────────────────

def _probe_domain(domain: str) -> list[dict]:
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
                content_type = resp.headers.get("content-type", "")
                # Quick check: looks like XML/RSS?
                body = resp.text[:500]
                if not ("<rss" in body or "<feed" in body or "<channel>" in body):
                    if "xml" not in content_type and "rss" not in content_type:
                        continue
                parsed = feedparser.parse(resp.content)
                if parsed.entries:
                    title = parsed.feed.get("title", domain)
                    results.append({
                        "name": title[:200],
                        "feed_url": url,
                        "description": (parsed.feed.get("description") or "")[:500],
                        "strategy": "probe",
                        "valid": True,
                        "entry_count": len(parsed.entries),
                    })
                    break  # Found a working feed, stop probing
            except Exception:
                continue
            time.sleep(0.2)  # Be polite
    return results


# ── Strategy 2: Web search for RSS feeds ─────────────────────────────

# Country → primary language code (ISO 639-1)
_COUNTRY_LANGUAGES: dict[str, str] = {
    # Spanish-speaking Latin America
    "MX": "es", "AR": "es", "CO": "es", "CL": "es", "PE": "es", "VE": "es",
    "EC": "es", "BO": "es", "PY": "es", "UY": "es", "GT": "es", "SV": "es",
    "HN": "es", "NI": "es", "CR": "es", "PA": "es", "CU": "es", "DO": "es",
    "JM": "es", "TT": "es", "BB": "en", "BS": "en", "LC": "en", "GD": "en",
    "VC": "en", "AG": "en", "DM": "en", "KN": "en", "PR": "es", "GU": "en",
    # Portuguese
    "BR": "pt", "PT": "pt", "AO": "pt", "MZ": "pt", "CV": "pt",
    # French
    "FR": "fr", "BE": "fr", "CH": "fr", "CI": "fr", "SN": "fr", "ML": "fr",
    "BF": "fr", "TG": "fr", "BJ": "fr", "NE": "fr", "CD": "fr", "CG": "fr",
    "GA": "fr", "GQ": "fr", "CF": "fr", "CM": "fr", "HT": "fr", "DJ": "fr",
    # German
    "DE": "de", "AT": "de", "CH": "de", "LI": "de",
    # Italian
    "IT": "it",
    # Spanish (Europe)
    "ES": "es",
    # Russian & related
    "RU": "ru", "UA": "uk", "BY": "be", "KZ": "kk", "KG": "ky",
    "UZ": "uz", "TJ": "tg", "TM": "tk",
    # Chinese
    "CN": "zh", "TW": "zh", "HK": "zh", "MO": "zh",
    # Japanese & Korean
    "JP": "ja", "KR": "ko", "KP": "ko",
    # South Asia
    "IN": "hi", "PK": "ur", "BD": "bn", "LK": "si", "NP": "ne",
    "BT": "dz", "AF": "ps",
    # Southeast Asia
    "TH": "th", "LA": "lo", "KH": "km", "MM": "my", "VN": "vi",
    "ID": "id", "MY": "ms", "BN": "ms", "SG": "en", "TL": "pt",
    "PH": "tl",
    # Middle East & North Africa
    "EG": "ar", "SA": "ar", "AE": "ar", "IQ": "ar", "SY": "ar",
    "JO": "ar", "LB": "ar", "YE": "ar", "MA": "ar", "TN": "ar",
    "LY": "ar", "SD": "ar", "SO": "so", "MR": "ar",
    "IR": "fa", "IL": "he", "TR": "tr", "PS": "ar",
    # Central Asia
    "GE": "ka", "AM": "hy", "AZ": "az",
    # Africa
    "NG": "en", "KE": "en", "ZA": "en", "GH": "en", "TZ": "sw", "UG": "en",
    "RW": "rw", "BI": "rw", "ET": "en", "ER": "ti", "SO": "so",
    "MW": "en", "ZM": "en", "ZW": "en", "BW": "en", "NA": "en",
    "LS": "en", "SZ": "en", "MU": "en", "SC": "en", "KM": "ar",
    # Europe
    "PL": "pl", "GR": "el", "RO": "ro", "HU": "hu", "CZ": "cs",
    "SK": "sk", "RS": "sr", "HR": "hr", "SI": "sl", "BA": "bs",
    "MK": "mk", "AL": "sq", "BG": "bg", "NL": "nl", "BE": "nl",
    "SE": "sv", "NO": "no", "DK": "da", "FI": "fi", "IS": "is",
    "IE": "en", "GB": "en", "AU": "en", "NZ": "en", "CA": "en",
    "US": "en", "PG": "en", "FJ": "en", "WS": "en", "TO": "en",
    "VU": "en", "SB": "en", "KI": "en", "FM": "en", "PW": "en",
    "MH": "en", "CK": "en", "NU": "en",
}


def _search_web(query: str, country: str | None = None, language: str | None = None) -> list[dict]:
    """Search the web for RSS feeds and news sites matching a query.

    Uses DuckDuckGo HTML (no API key needed). Returns candidate URLs
    that we then probe for feeds or validate as scrapable web sources.

    Supports multilingual search - when language is specified, searches in
    both English and the local language for better coverage.
    """
    results = []
    seen_domains: set[str] = set()

    # Determine search language
    if language is None and country:
        language = _COUNTRY_LANGUAGES.get(country.upper())

    # Get search terms based on language
    base_terms = LANGUAGE_SEARCH_TERMS.get(language, ["RSS feed", "news feed", "newspaper"])

    # Build search queries: local language + English fallback
    search_queries = []
    for term in base_terms[:2]:  # Use up to 2 search terms per language
        sq = f"{query} {term}"
        if country:
            sq += f" {country}"
        search_queries.append(sq)

    # Also always do English search for international sources
    if language != "en":
        en_sq = f"{query} RSS feed"
        if country:
            en_sq += f" {country}"
        search_queries.append(en_sq)

    for search_query in search_queries:
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                resp = client.get(
                    "https://html.duckduckgo.com/html/",
                    params={"q": search_query},
                    headers={"User-Agent": USER_AGENT},
                )
                if resp.status_code != 200:
                    continue

                # Extract URLs from DuckDuckGo HTML results
                url_pattern = re.compile(r'class="result__a"[^>]*href="([^"]+)"', re.I)
                matches = url_pattern.findall(resp.text)

                if not matches:
                    url_pattern2 = re.compile(r'uddg=([^&"]+)', re.I)
                    matches = [u for u in url_pattern2.findall(resp.text)]

                for raw_url in matches[:15]:
                    if "uddg=" in raw_url:
                        from urllib.parse import unquote
                        raw_url = unquote(raw_url.split("uddg=")[1].split("&")[0])

                    try:
                        parsed = urlparse(raw_url)
                        domain = parsed.netloc.lower()
                        if not domain or domain in seen_domains:
                            continue
                        seen_domains.add(domain)
                    except Exception:
                        continue

        except Exception as e:
            log.warning("web search failed for '%s': %s", search_query, e)

        time.sleep(0.5)

    # Probe the top domains for feeds
    for domain in list(seen_domains)[:10]:
        found = _probe_domain(domain)
        results.extend(found)
        time.sleep(0.5)

    return results


# ── Strategy 3: RSS directory lookup ─────────────────────────────────

def _search_directories(query: str, country: str | None = None) -> list[dict]:
    """Search RSS directories for feeds matching a query."""
    results = []

    # Try feedly.com search API (public, no key needed)
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(
                "https://cloud.feedly.com/v3/search/feeds",
                params={"query": query, "count": 20},
                headers={"User-Agent": USER_AGENT},
            )
            if resp.status_code == 200:
                data = resp.json()
                for item in data.get("results", []):
                    feed_url = item.get("feedId", "")
                    if feed_url.startswith("feed/"):
                        feed_url = feed_url[5:]
                    if not feed_url.startswith("http"):
                        continue
                    results.append({
                        "name": (item.get("title") or "")[:200],
                        "feed_url": feed_url,
                        "description": (item.get("description") or "")[:500],
                        "website": item.get("website", ""),
                        "strategy": "feedly",
                        "valid": None,  # not validated yet
                        "subscribers": item.get("subscribers", 0),
                    })
    except Exception as e:
        log.debug("feedly search failed: %s", e)

    return results


# ── Strategy 4: AI discovery ─────────────────────────────────────────

def _search_ai(query: str, country: str | None = None) -> list[dict]:
    """Ask the AI endpoint for news source suggestions."""
    import os
    ai_url = os.environ.get("XYZO_AI_CHAT_URL", "http://192.168.1.3:8888/chat/stream")

    country_hint = f" for country code {country}" if country else ""
    prompt = f"""Find RSS news feeds matching: "{query}"{country_hint}

Return a JSON array of news sources. Each entry:
- name: outlet name
- feed_url: RSS/Atom URL (must be real)
- country: ISO 2-letter code
- language: "en" or local code
- region: descriptive region tag
- description: brief description

Return ONLY a valid JSON array. Up to 10 sources. Only include feeds you are confident exist."""

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                ai_url,
                json={"message": prompt, "stream": True},
                headers={**SAFE_HEADERS, "Content-Type": "application/json"},
            )
            resp.raise_for_status()

            full_text = ""
            for line in resp.text.split("\n"):
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                    delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    full_text += delta
                except json.JSONDecodeError:
                    continue

        # Parse JSON array from response
        matches = re.findall(r'\[[\s\S]*?\]', full_text)
        for match in matches:
            try:
                sources = json.loads(match)
                if isinstance(sources, list):
                    results = []
                    for s in sources:
                        if isinstance(s, dict) and s.get("name") and s.get("feed_url"):
                            url = s["feed_url"]
                            if url.startswith("http"):
                                results.append({
                                    "name": s["name"][:200],
                                    "feed_url": url,
                                    "country": (s.get("country") or "")[:2].upper(),
                                    "language": (s.get("language") or "en")[:5],
                                    "region": (s.get("region") or "unknown")[:50],
                                    "description": (s.get("description") or "")[:500],
                                    "strategy": "ai",
                                    "valid": None,
                                })
                    return results[:10]
            except json.JSONDecodeError:
                continue

    except Exception as e:
        log.debug("AI source search failed: %s", e)

    return []


# ── Validation ───────────────────────────────────────────────────────

def validate_feed(url: str) -> dict:
    """Validate a single feed URL. Returns {valid, title, entry_count, error}."""
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": USER_AGENT})
            if resp.status_code >= 400:
                return {"valid": False, "title": None, "entry_count": 0, "error": f"HTTP {resp.status_code}"}

            parsed = feedparser.parse(resp.content)
            if parsed.bozo and not parsed.entries:
                return {"valid": False, "title": None, "entry_count": 0, "error": str(parsed.bozo_exception)[:200]}

            title = parsed.feed.get("title", "")
            entries = parsed.entries or []
            return {
                "valid": len(entries) > 0,
                "title": title[:200] if title else None,
                "entry_count": len(entries),
                "error": None if entries else "No entries found",
            }
    except Exception as e:
        return {"valid": False, "title": None, "entry_count": 0, "error": str(e)[:200]}


def validate_feeds(urls: list[str], max_validate: int = 30) -> list[dict]:
    """Validate multiple feed URLs. Returns list of {url, valid, title, entry_count, error}."""
    results = []
    for url in urls[:max_validate]:
        result = validate_feed(url)
        result["url"] = url
        results.append(result)
        time.sleep(0.3)  # Be polite
    return results


# ── Main discovery function ──────────────────────────────────────────


# ── Metrics & Timing Helpers ──────────────────────────────────────────

def record_discovery_step_metrics(
    run_id: str,
    query: str,
    country: str | None,
    step_durations: dict[str, float],
    step_candidates: dict[str, int] | None = None,
) -> None:
    """Record timing duration (in ms) for each step of a discovery run."""
    if step_candidates is None:
        step_candidates = {}

    try:
        with connect() as conn, conn.cursor() as cur:
            for step_name, duration_ms in step_durations.items():
                cand_count = step_candidates.get(step_name, 0)
                cur.execute(
                    """
                    INSERT INTO news_discovery_step_metrics
                    (run_id, query, country, step_name, duration_ms, candidate_count)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (run_id, query[:500], country, step_name, duration_ms, cand_count),
                )
    except Exception as e:
        log.warning("failed to record discovery step metrics: %s", e)


def get_discovery_step_averages(days: int = 30) -> dict:
    """Get historical average step durations for AI news discovery."""
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    step_name,
                    ROUND(AVG(duration_ms)::numeric, 2) AS avg_ms,
                    ROUND(MIN(duration_ms)::numeric, 2) AS min_ms,
                    ROUND(MAX(duration_ms)::numeric, 2) AS max_ms,
                    ROUND(AVG(candidate_count)::numeric, 2) AS avg_candidates,
                    COUNT(*) AS sample_count
                FROM news_discovery_step_metrics
                WHERE created_at > NOW() - (INTERVAL '1 day' * %s)
                GROUP BY step_name
                ORDER BY step_name
                """,
                (days,),
            )
            rows = cur.fetchall()

            steps = {}
            step_averages = {}
            for r in rows:
                s_name = r["step_name"]
                avg_val = float(r["avg_ms"])
                step_averages[s_name] = avg_val
                steps[s_name] = {
                    "avg_ms": avg_val,
                    "min_ms": float(r["min_ms"]),
                    "max_ms": float(r["max_ms"]),
                    "avg_candidates": float(r["avg_candidates"]),
                    "sample_count": int(r["sample_count"]),
                }

            cur.execute(
                """
                SELECT COUNT(DISTINCT run_id) AS total_runs
                FROM news_discovery_step_metrics
                WHERE created_at > NOW() - (INTERVAL '1 day' * %s)
                """,
                (days,),
            )
            r_run = cur.fetchone()
            total_runs = int(r_run["total_runs"]) if r_run else 0

            return {
                "step_averages_ms": step_averages,
                "step_details": steps,
                "total_runs": total_runs,
            }
    except Exception as e:
        log.warning("failed to fetch discovery step averages: %s", e)
        return {"step_averages_ms": {}, "step_details": {}, "total_runs": 0}


def discover_sources(
    query: str,
    country: str | None = None,
    strategies: list[str] | None = None,
    include_existing: bool = False,
) -> dict:
    """Search for news sources matching a query with high-precision step timing instrumentation.

    Args:
        query: Free-text search (e.g. "Korean news", "tech blogs", "Pakistan")
        country: ISO country code override (auto-detected from query if None)
        strategies: Which strategies to use (default: all)
        include_existing: If True, include feeds already in the DB

    Returns:
        {
            query, country, strategies_used, run_id,
            candidates: [...], already_exists: [...],
            step_durations_ms: {resolve_country, existing_lookup, strategy_probe, strategy_web, strategy_directory, strategy_ai, dedup_split, validate, total},
            avg_step_durations_ms: {resolve_country, existing_lookup, strategy_probe, ...},
            summary: str,
        }
    """
    t_start = time.perf_counter()
    run_id = str(uuid.uuid4())
    step_durations_ms: dict[str, float] = {}
    step_candidates: dict[str, int] = {}

    # Step 1: Resolve country
    t0 = time.perf_counter()
    if country is None:
        country = _resolve_country(query)
    step_durations_ms["resolve_country"] = round((time.perf_counter() - t0) * 1000, 2)

    if strategies is None:
        strategies = ["probe", "web", "directory", "ai"]

    # Step 2: Existing feeds lookup
    t0 = time.perf_counter()
    existing = _existing_feed_urls()
    feeds_json_urls = _load_feeds_json_urls()
    all_existing = existing | feeds_json_urls
    step_durations_ms["existing_lookup"] = round((time.perf_counter() - t0) * 1000, 2)

    candidates = []
    seen_urls = set()
    strategies_used = []

    # Step 3: Strategy - Probe common patterns
    if "probe" in strategies:
        t0 = time.perf_counter()
        domain_match = re.search(r'([\w-]+\.(?:com|org|net|co\.\w+|gov|edu))', query.lower())
        probe_found = []
        if domain_match:
            domain = domain_match.group(1)
            probe_found = _probe_domain(domain)
            for f in probe_found:
                if f["feed_url"] not in seen_urls:
                    seen_urls.add(f["feed_url"])
                    candidates.append(f)
            strategies_used.append("probe")
        step_durations_ms["strategy_probe"] = round((time.perf_counter() - t0) * 1000, 2)
        step_candidates["strategy_probe"] = len(probe_found)

    # Step 4: Strategy - Web search
    if "web" in strategies:
        t0 = time.perf_counter()
        web_found = _search_web(query, country)
        for f in web_found:
            if f["feed_url"] not in seen_urls:
                seen_urls.add(f["feed_url"])
                candidates.append(f)
        strategies_used.append("web")
        step_durations_ms["strategy_web"] = round((time.perf_counter() - t0) * 1000, 2)
        step_candidates["strategy_web"] = len(web_found)

    # Step 5: Strategy - RSS directories
    if "directory" in strategies:
        t0 = time.perf_counter()
        dir_found = _search_directories(query, country)
        for f in dir_found:
            if f["feed_url"] not in seen_urls:
                seen_urls.add(f["feed_url"])
                candidates.append(f)
        strategies_used.append("directory")
        step_durations_ms["strategy_directory"] = round((time.perf_counter() - t0) * 1000, 2)
        step_candidates["strategy_directory"] = len(dir_found)

    # Step 6: Strategy - AI discovery
    if "ai" in strategies:
        t0 = time.perf_counter()
        ai_found = _search_ai(query, country)
        for f in ai_found:
            if f["feed_url"] not in seen_urls:
                seen_urls.add(f["feed_url"])
                candidates.append(f)
        strategies_used.append("ai")
        step_durations_ms["strategy_ai"] = round((time.perf_counter() - t0) * 1000, 2)
        step_candidates["strategy_ai"] = len(ai_found)

    # Step 7: Deduplicate and split new vs existing
    t0 = time.perf_counter()
    new_candidates = []
    already_exists = []
    for c in candidates:
        if c["feed_url"] in all_existing:
            already_exists.append(c)
        else:
            new_candidates.append(c)
    step_durations_ms["dedup_split"] = round((time.perf_counter() - t0) * 1000, 2)

    # Step 8: Feed validation
    t0 = time.perf_counter()
    to_validate = [c["feed_url"] for c in new_candidates if c.get("valid") is None]
    if to_validate:
        validations = {v["url"]: v for v in validate_feeds(to_validate, max_validate=20)}
        for c in new_candidates:
            v = validations.get(c["feed_url"])
            if v:
                c["valid"] = v["valid"]
                c["entry_count"] = v.get("entry_count", 0)
                if v.get("title") and not c.get("name"):
                    c["name"] = v["title"]
    step_durations_ms["validate"] = round((time.perf_counter() - t0) * 1000, 2)
    step_candidates["validate"] = len(to_validate)

    # Auto-fill country/region if missing
    for c in new_candidates:
        if not c.get("country") and country:
            c["country"] = country
        if not c.get("region") and c.get("country"):
            c["region"] = _COUNTRY_REGIONS.get(c["country"], "global")

    # Filter to valid only by default
    valid_candidates = [c for c in new_candidates if c.get("valid") is not False]

    # Total duration
    step_durations_ms["total"] = round((time.perf_counter() - t_start) * 1000, 2)
    step_candidates["total"] = len(valid_candidates)

    # Save metrics to DB
    record_discovery_step_metrics(
        run_id=run_id,
        query=query,
        country=country,
        step_durations=step_durations_ms,
        step_candidates=step_candidates,
    )

    # Retrieve historical step averages
    averages_data = get_discovery_step_averages()

    return {
        "query": query,
        "country": country,
        "strategies_used": strategies_used,
        "run_id": run_id,
        "candidates": valid_candidates,
        "already_exists": already_exists if include_existing else [],
        "step_durations_ms": step_durations_ms,
        "avg_step_durations_ms": averages_data.get("step_averages_ms", {}),
        "historical_step_metrics": averages_data.get("step_details", {}),
        "total_historical_runs": averages_data.get("total_runs", 0),
        "summary": f"Found {len(valid_candidates)} new sources, {len(already_exists)} already in DB in {step_durations_ms['total']}ms",
    }


# ── Bulk add ─────────────────────────────────────────────────────────

def add_source(source: dict) -> dict:
    """Add a single source to feeds.json and news_sources.

    Args:
        source: {name, feed_url, country, language, region, description, source_type}

    Returns:
        {added: bool, source_id: int|None, reason: str}
    """
    feed_url = source.get("feed_url", "").strip()
    if not feed_url:
        return {"added": False, "source_id": None, "reason": "missing_feed_url"}

    source_type = source.get("source_type", "rss")

    # Check if already exists
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, name FROM news_sources WHERE feed_url = %s", (feed_url,))
        existing = cur.fetchone()
        if existing:
            return {"added": False, "source_id": existing["id"], "reason": f"already_exists ({existing['name']})"}

    # Add to feeds.json
    try:
        with FEEDS_FILE.open() as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {"feeds": []}

    data["feeds"].append({
        "name": source.get("name", "Unknown"),
        "feed_url": feed_url,
        "country": source.get("country", ""),
        "language": source.get("language", "en"),
        "region": source.get("region", "global"),
        "source_type": source_type,
        "enabled": True,
    })

    with FEEDS_FILE.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # Add to news_sources
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
            VALUES (%s, %s, %s, %s, %s, %s, TRUE)
            ON CONFLICT (feed_url) DO NOTHING
            RETURNING id
            """,
            (source.get("name", "Unknown"), feed_url, source.get("country"),
             source.get("language", "en"), source.get("region", "global"), source_type),
        )
        row = cur.fetchone()
        source_id = row["id"] if row else None

    return {"added": True, "source_id": source_id, "reason": "added"}


def bulk_add(sources: list[dict]) -> dict:
    """Add multiple sources. Returns summary with per-source results."""
    results = []
    added = 0
    skipped = 0
    for src in sources:
        r = add_source(src)
        results.append({"feed_url": src.get("feed_url"), **r})
        if r["added"]:
            added += 1
        else:
            skipped += 1

    return {
        "total": len(sources),
        "added": added,
        "skipped": skipped,
        "results": results,
    }


# ── CLI ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if len(sys.argv) < 2:
        print("Usage: python -m worker.source_discovery <query> [--country XX] [--add]")
        sys.exit(1)

    query = sys.argv[1]
    country = None
    auto_add = "--add" in sys.argv

    for i, arg in enumerate(sys.argv):
        if arg == "--country" and i + 1 < len(sys.argv):
            country = sys.argv[i + 1].upper()

    result = discover_sources(query, country=country)
    print(json.dumps(result, indent=2, default=str))

    if auto_add and result["candidates"]:
        print(f"\nAdding {len(result['candidates'])} sources...")
        add_result = bulk_add(result["candidates"])
        print(json.dumps(add_result, indent=2))
