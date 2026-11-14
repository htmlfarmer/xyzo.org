"""Daily digest — the editorial layer behind the daily news video.

Picks the day's most *interesting* stories (not simply the loudest ones)
and writes a reviewable JSON artifact that the site, the video renderer and
the uploader all read from.

WHY A DIGEST FIRST
------------------
"Top news" is easy and boring: it is whatever has the most articles, which
usually means wire copy of a story three days old. "Interesting" is a
different question and needs a different answer:

  * is it ACCELERATING, or just big?
  * is it CORROBORATED by independent outlets, or one wire story copied
    40 times?
  * has it SPREAD across countries (global significance) or is it local?
  * is it NEW, or the fourth day of the same thing?
  * is it CONNECTED to other events, or an island?
  * is it UNDER-COVERED — big and thin, i.e. nobody is reporting it?

The ranking blends those signals, then an editor pass enforces variety (a
day cannot be five wars), then the local model writes the one-line "why"
and a spoken narration for each pick.

OUTPUT
------
    data/daily_digest.json

Usage:
    python3 -m worker.daily_digest --dry-run          # print, write nothing
    python3 -m worker.daily_digest --print             # human-readable preview
    python3 -m worker.daily_digest                      # write the artifact
    python3 -m worker.daily_digest --no-ai              # skip the model calls
    python3 -m worker.daily_digest --hours 12 --stories 8
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .country_normalizer import normalize_country
from .db import connect

# ── configuration ────────────────────────────────────────────────────────────

DEFAULT_WINDOW_HOURS = 24
CANDIDATE_POOL = 400     # events pulled out of the velocity table
SHORTLIST = 30           # events that get the full signal treatment
DEFAULT_STORIES = 10
MIN_ARTICLES_24H = 3
MIN_OUTLETS = 1
# The model's "international: no" is the veto. The 0-10 interest score is only
# a nudge, because a small model rates everything in the middle.
AI_VETO_INTEREST = 3.0
# How many candidates to hand to the model (extra so vetoes can be replaced).
AI_POOL_MULTIPLIER = 5
AI_MAX_POOL = 44

# A source counts as a credible outlet above this reliability score.
CREDIBLE_RELIABILITY = 0.5
# "Top tier" outlets (used to measure real institutional pickup).
TOP_RELIABILITY = 0.8

# Aggregators inflate article counts without adding corroboration.
AGGREGATOR_PATTERNS = ("google news", "news - ", "msn", "yahoo", "flipboard")

# Headlines that are not news: shopping round-ups, press releases, listicles,
# sponsored content, opinion pieces with no event in them. These are filtered
# out before scoring — a daily digest is not a newsletter.
VETO_PATTERNS = (
    "best ", "top 10", "top 15", "deals", "discount", "coupon", "promo code",
    "sale", "black friday", "gift guide", "shopping", "prime day",
    "review:", "vs.", "sign up", "subscribe", "newsletter", "podcast episode",
    "how to", "what is", "explained:", "recipe", "horoscope", "lottery",
    "stocks to watch", "price target", "analyst rating", "press release",
    "sponsored", "advertorial", "giveaway", "sweepstake", "win a ",
    "live blog", "live updates", "opinion:", "editorial:", "obituary",
    "in memoriam", "birthday", "anniversary", "horoscopes",
    # corporate noise — not news
    "earnings call", "conference call", "quarterly results", "investor day",
    "investor relations", "profit warning", "dividend", "share price",
    "stock price", "q1 ", "q2 ", "q3 ", "q4 ", "transcript",
    # content-farm / listicle / engagement bait
    "highlights", "full coverage", "as it happened", "watch:", "photos:",
    "in pictures", "quiz", "poll:", "timeline:", "profile:", "interview:",
)

# "10 movies that…", "5 ways to…", "7 things…"
LISTICLE_RE = re.compile(
    r"\b\d{1,2}\s+(movies|films|things|ways|reasons|people|questions|lessons|"
    r"facts|tips|books|songs|albums|websites|apps|tools|signs|habits)\b",
    re.I,
)

# A story is a duplicate of another when the story graph already connects
# them strongly (the same incident picked up by different clusters).
DUPLICATE_LINK_STRENGTH = 0.95
# Two events sharing this fraction of their articles are the same story.
DUPLICATE_ARTICLE_OVERLAP = 0.5

# Signal weights. They sum to 1.0.
WEIGHTS = {
    "acceleration": 0.18,   # rising, not just big
    "corroboration": 0.18,  # independent credible outlets
    "momentum": 0.16,       # overall velocity
    "spread": 0.14,         # countries involved
    "novelty": 0.12,        # fresh vs. day 4 of the same story
    "undercoverage": 0.08,  # big but thinly reported
    "graph": 0.08,          # connected to other events
    "independence": 0.06,   # not syndicated wire copy
}

# event_type -> coarse editorial category (drives the variety constraint)
CATEGORY_MAP: dict[str, str] = {
    # conflict & politics
    "conflict": "conflict", "war": "conflict", "military": "conflict",
    "protest": "conflict", "demonstration": "conflict", "diplomacy": "conflict",
    "elections": "politics", "politics": "politics", "government": "politics",
    "policy": "politics", "corruption": "politics", "courts": "politics",
    "crime": "conflict", "terrorism": "conflict", "shooting": "conflict",
    "human_rights": "politics", "sanctions": "politics", "immigration": "politics",
    "geopolitics": "conflict", "cybercrime": "conflict", "humanitarian": "conflict",
    "refugees": "conflict", "aid": "conflict", "missing": "conflict",
    # climate & environment
    "weather": "climate", "weather_alert": "climate", "climate": "climate",
    "environment": "climate", "disaster": "climate", "earthquake": "climate",
    "volcano": "climate", "floods": "climate", "wildfire": "climate", "storm": "climate",
    "cyclone": "climate", "drought": "climate", "heatwave": "climate", "snow": "climate",
    "pollution": "climate", "deforestation": "climate", "wildlife": "climate",
    "agriculture": "climate", "water": "climate", "energy": "climate",
    # economy
    "business": "economy", "economy": "economy", "finance": "economy",
    "markets": "economy", "banking": "economy", "trade": "economy",
    "manufacturing": "economy", "retail": "economy", "shipping": "economy",
    "maritime": "economy", "startups": "economy", "employment": "economy",
    "rail": "economy", "traffic": "economy", "aviation": "economy",
    "telecom": "economy", "development": "economy",
    # technology
    "technology": "tech", "ai": "tech", "cybersecurity": "tech",
    "software": "tech", "gaming": "tech", "social_issues": "tech",
    # health
    "health": "health", "healthcare": "health", "medical": "health",
    "medicine": "health", "epidemic": "health", "vaccines": "health",
    "mental_health": "health", "biology": "health",
    # science
    "science": "science", "research": "science", "space": "science",
    # culture & sport
    "culture": "culture", "film": "culture", "music": "culture", "art": "culture",
    "entertainment": "culture", "theater": "culture", "literature": "culture",
    "festivals": "culture", "religion": "culture", "sports": "culture",
    "soccer": "culture", "basketball": "culture", "cricket": "culture",
    "tennis": "culture", "swimming": "culture", "athletics": "culture",
    "motorsport": "culture", "racing": "culture", "olympics": "culture",
    # society
    "demographics": "society", "poverty": "society", "inequality": "society",
    "housing": "society", "education": "society",
}
FALLBACK_CATEGORY = "other"

CATEGORIES = ["conflict", "politics", "climate", "economy", "tech", "health",
              "science", "culture", "society", "other"]

# The editorial standard: what a global news desk actually runs. Culture and
# society stories are almost never front-page material — they are only used
# to fill the digest if nothing better turned up.
EDITORIAL_CATEGORIES = ("conflict", "politics", "climate", "economy", "tech",
                        "health", "science")
# "other" is never a filler — it means the model could not classify the
# story, which is exactly the signal we do not want in a digest.
FILLER_CATEGORIES = ("culture", "society")

# A story needs real independent corroboration to be a world story.
MIN_CREDIBLE_OUTLETS = 4
# …and either reach beyond one country, or be picked up by many outlets.
MIN_COUNTRIES = 2
MANY_OUTLETS = 8

# The variety constraint: at most N stories per category / country / region.
MAX_PER_CATEGORY = 3
MAX_PER_COUNTRY = 2
MAX_PER_REGION = 4

# ISO-3166 alpha-2 -> coarse region, for the variety constraint. Only the
# countries that realistically show up in a daily digest need an entry;
# anything unknown is bucketed by its first letter so the cap still bites.
COUNTRY_REGION = {
    "AE": "middle-east", "SA": "middle-east", "IR": "middle-east",
    "IQ": "middle-east", "IL": "middle-east", "JO": "middle-east",
    "LB": "middle-east", "SY": "middle-east", "YE": "middle-east",
    "QA": "middle-east", "KW": "middle-east", "BH": "middle-east",
    "EG": "africa", "NG": "africa", "ZA": "africa", "KE": "africa",
    "ET": "africa", "GH": "africa", "TZ": "africa", "UG": "africa",
    "SD": "africa", "SN": "africa", "CI": "africa", "CM": "africa",
    "ZW": "africa", "ZM": "africa", "AO": "africa", "MZ": "africa",
    "MA": "africa", "DZ": "africa", "TN": "africa", "LY": "africa",
    "TD": "africa", "ML": "africa", "BF": "africa", "NE": "africa",
    "US": "americas", "CA": "americas", "MX": "americas", "BR": "americas",
    "AR": "americas", "CL": "americas", "CO": "americas", "PE": "americas",
    "VE": "americas", "EC": "americas", "BO": "americas", "UY": "americas",
    "PY": "americas", "GT": "americas", "CU": "americas", "DO": "americas",
    "CR": "americas", "PA": "americas", "HN": "americas", "JM": "americas",
    "RU": "europe", "UA": "europe", "PL": "europe", "DE": "europe",
    "FR": "europe", "GB": "europe", "ES": "europe", "IT": "europe",
    "NL": "europe", "BE": "europe", "SE": "europe", "NO": "europe",
    "DK": "europe", "FI": "europe", "GR": "europe", "PT": "europe",
    "IE": "europe", "AT": "europe", "CH": "europe", "CZ": "europe",
    "SK": "europe", "HU": "europe", "RO": "europe", "BG": "europe",
    "RS": "europe", "HR": "europe", "SI": "europe", "LT": "europe",
    "LV": "europe", "EE": "europe", "IS": "europe", "MD": "europe",
    "BY": "europe", "GE": "europe", "AM": "europe", "AZ": "europe",
    "TR": "europe", "CN": "asia", "JP": "asia", "KR": "asia",
    "IN": "asia", "PK": "asia", "BD": "asia", "NP": "asia",
    "LK": "asia", "MM": "asia", "TH": "asia", "VN": "asia",
    "KH": "asia", "LA": "asia", "MN": "asia", "KZ": "asia",
    "UZ": "asia", "AF": "asia", "ID": "asia", "PH": "asia",
    "MY": "asia", "SG": "asia", "TW": "asia", "HK": "asia",
    "SAU": "middle-east", "AU": "oceania", "NZ": "oceania",
    "FJ": "oceania", "PG": "oceania",
}

DEFAULT_OUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "daily_digest.json"
)


# ── helpers ─────────────────────────────────────────────────────────────────

def _log(msg: str) -> None:
    print(f"[digest] {msg}", flush=True)


def category_of(event_type: Optional[str]) -> str:
    if not event_type:
        return FALLBACK_CATEGORY
    return CATEGORY_MAP.get(event_type.strip().lower(), FALLBACK_CATEGORY)


def _is_aggregator(name: str) -> bool:
    low = (name or "").lower()
    return any(p in low for p in AGGREGATOR_PATTERNS)


def is_promotional(headline: str) -> bool:
    """True for shopping listicles / press releases / non-news content."""
    low = (headline or "").lower()
    if any(p in low for p in VETO_PATTERNS):
        return True
    return bool(LISTICLE_RE.search(headline or ""))


def _clean_headline(text: Optional[str]) -> str:
    """Strip CSS/HTML fragments that occasionally survive into headlines."""
    if not text:
        return ""
    t = re.sub(r"<[^>]+>", " ", text)
    t = re.sub(r"\.[\w-]+\s*\{[^}]*\}", " ", t)     # css rules first
    t = re.sub(r"\{[^{}]{0,400}\}", " ", t)          # then bare css blocks
    t = re.sub(r"[\r\n\t]+", " ", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    return t


def _norm(value: float, ceiling: float) -> float:
    """Map a positive quantity onto 0..1 with a soft ceiling."""
    if value <= 0 or ceiling <= 0:
        return 0.0
    return min(1.0, math.log1p(value) / math.log1p(ceiling))


# ── data access ─────────────────────────────────────────────────────────────

def fetch_candidates(conn, window_hours: int, pool: int) -> list[dict]:
    """Top events by raw velocity inside the window (cheap, no big joins)."""
    sql = """
        SELECT e.id,
               e.headline,
               e.summary,
               e.event_type,
               e.first_reported_at,
               v.velocity_score,
               v.acceleration_1h,
               v.acceleration_6h,
               v.articles_1h,
               v.articles_6h,
               v.articles_24h,
               v.sources_1h,
               v.sources_6h,
               v.sources_24h,
               v.countries_24h,
               v.syndicated_copies,
               v.unique_sources,
               v.first_article_at,
               v.last_article_at,
               v.geographic_spread_km,
               l.place_name,
               l.country,
               l.lat,
               l.lng
          FROM news_event_velocity v
          JOIN news_events e ON e.id = v.event_id AND e.status = 'active'
          LEFT JOIN news_locations l ON l.id = e.primary_location_id
         WHERE v.updated_at > now() - make_interval(hours => %s)
           AND v.articles_24h >= %s
         ORDER BY v.velocity_score DESC
         LIMIT %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (window_hours, MIN_ARTICLES_24H, pool))
        cols = [d[0] for d in cur.description]
        rows = []
        for r in cur.fetchall():
            # The pooled connection uses psycopg's dict_row factory, but be
            # tolerant of plain tuples too.
            rows.append(dict(r) if isinstance(r, dict) else dict(zip(cols, r)))
    _log(f"{len(rows)} candidate events from the last {window_hours}h")
    return rows


def fetch_outlet_stats(conn, event_ids: list[int]) -> dict[int, dict]:
    """Per-event outlet/source statistics (credible outlets, countries, names)."""
    if not event_ids:
        return {}
    sql = """
        SELECT es.event_id,
               count(*)                                            AS articles,
               count(DISTINCT a.source_id)                         AS outlets,
               count(DISTINCT s.country)                           AS outlet_countries,
               count(DISTINCT s.id) FILTER (WHERE s.reliability_score >= %s) AS credible_outlets,
               count(DISTINCT s.id) FILTER (WHERE s.reliability_score >= %s) AS top_outlets,
               count(DISTINCT s.language)                          AS languages,
               array_agg(DISTINCT s.name) FILTER (
                   WHERE s.reliability_score >= %s AND s.name NOT ILIKE '%%google news%%'
               )                                                   AS credible_names,
               array_agg(DISTINCT es.article_id)                  AS article_ids
          FROM news_event_sources es
          JOIN news_articles a ON a.id = es.article_id
          JOIN news_sources  s ON s.id = a.source_id
         WHERE es.event_id = ANY(%s)
         GROUP BY es.event_id
    """
    with conn.cursor() as cur:
        cur.execute(sql, (CREDIBLE_RELIABILITY, TOP_RELIABILITY,
                          TOP_RELIABILITY, event_ids))
        out: dict[int, dict] = {}
        for row in cur.fetchall():
            vals = list(row.values()) if isinstance(row, dict) else list(row)
            out[vals[0]] = {
                "articles": vals[1],
                "outlets": vals[2],
                "outlet_countries": vals[3],
                "credible_outlets": vals[4],
                "top_outlets": vals[5],
                "languages": vals[6],
                "credible_names": [n for n in (vals[7] or []) if not _is_aggregator(n)][:12],
                "article_ids": set(vals[8] or ()),
            }
    return out


def fetch_graph_links(conn, event_ids: list[int]) -> dict[int, int]:
    """How many *other* events each candidate is linked to (story graph)."""
    if not event_ids:
        return {}
    sql = """
        SELECT es.event_id,
               count(*) AS cross_links,
               count(DISTINCT l.target_article_id) AS distinct_targets
          FROM news_event_sources es
          JOIN news_story_links l ON l.source_article_id = es.article_id
         WHERE es.event_id = ANY(%s)
           AND l.link_strength >= 0.5
           AND NOT EXISTS (
               SELECT 1 FROM news_event_sources es2
                WHERE es2.article_id = l.target_article_id
                  AND es2.event_id = es.event_id
           )
         GROUP BY es.event_id
    """
    with conn.cursor() as cur:
        cur.execute(sql, (event_ids,))
        out: dict[int, int] = {}
        for row in cur.fetchall():
            vals = list(row.values()) if isinstance(row, dict) else list(row)
            out[vals[0]] = max(vals[1], vals[2])
        return out


def fetch_sample_articles(conn, event_id: int, limit: int = 4) -> list[dict]:
    """A few credible article URLs per event — the 'read more' links."""
    sql = """
        SELECT a.title, a.url, s.name, s.country, a.published_at
          FROM news_event_sources es
          JOIN news_articles a ON a.id = es.article_id
          JOIN news_sources  s ON s.id = a.source_id
         WHERE es.event_id = %s
           AND s.reliability_score >= %s
           AND s.name NOT ILIKE '%%google news%%'
         ORDER BY s.reliability_score DESC, a.published_at DESC
         LIMIT %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (event_id, CREDIBLE_RELIABILITY, limit))
        out = []
        for row in cur.fetchall():
            v = list(row.values()) if isinstance(row, dict) else list(row)
            out.append({
                "title": v[0], "url": v[1], "source": v[2], "country": v[3],
                "published_at": v[4].isoformat() if v[4] else None,
            })
        return out


def fetch_duplicate_pairs(conn, event_ids: list[int]) -> set[tuple[int, int]]:
    """Pairs of candidate events that are really the same story.

    Clustering splits one incident into several events (different headline
    languages, different angles). The story graph already knows they are the
    same — text similarity does not (trigram similarity between two
    headlines about the same airport attack can be as low as 0.30).
    """
    if len(event_ids) < 2:
        return set()
    sql = """
        SELECT DISTINCT es.event_id AS a_id, es2.event_id AS b_id
          FROM news_event_sources es
          JOIN news_story_links l ON l.source_article_id = es.article_id
          JOIN news_event_sources es2 ON es2.article_id = l.target_article_id
         WHERE es.event_id = ANY(%s)
           AND es2.event_id = ANY(%s)
           AND es2.event_id <> es.event_id
           AND l.link_strength >= %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (event_ids, event_ids, DUPLICATE_LINK_STRENGTH))
        out: set[tuple[int, int]] = set()
        for row in cur.fetchall():
            vals = list(row.values()) if isinstance(row, dict) else list(row)
            a, b = int(vals[0]), int(vals[1])
            out.add((a, b) if a < b else (b, a))
        return out


def dedupe_stories(scored: list[dict], stats: dict[int, dict],
                   dup_pairs: set[tuple[int, int]]) -> list[dict]:
    """Collapse duplicate events, keeping the best-scoring member of each.

    Two events are the same story when they share most of their articles
    (the same wire copy clustered twice) or when the story graph already
    links them almost perfectly. Matching is *pairwise and greedy* — the
    story graph is transitive, so transitive clustering chains unrelated
    events into one blob and swallows the good stories.
    """
    if not scored:
        return scored

    kept: list[dict] = []
    for cand in scored:
        eid = int(cand["id"])
        arts = stats.get(eid, {}).get("article_ids") or set()
        duplicate_of = None
        for other in kept:
            oid = int(other["id"])
            if (min(eid, oid), max(eid, oid)) in dup_pairs:
                duplicate_of = other
                break
            other_arts = stats.get(oid, {}).get("article_ids") or set()
            if arts and other_arts:
                overlap = len(arts & other_arts) / max(1, min(len(arts), len(other_arts)))
                if overlap >= DUPLICATE_ARTICLE_OVERLAP:
                    duplicate_of = other
                    break
        if duplicate_of is not None:
            duplicate_of.setdefault("also_seen", []).append(cand["headline"])
            continue
        kept.append(cand)
    return kept


def fetch_story_location(conn, event_id: int) -> Optional[dict]:
    """The place most of the credible outlets put the story.

    The event's primary_location can be wrong (a Gaza story filed under
    New York); the modal location across the credible articles is far more
    reliable.
    """
    sql = """
        SELECT a.location_text,
               a.extracted_lat,
               a.extracted_lng,
               count(*) AS n
          FROM news_event_sources es
          JOIN news_articles a ON a.id = es.article_id
          JOIN news_sources  s ON s.id = a.source_id
         WHERE es.event_id = %s
           AND s.reliability_score >= %s
           AND a.extracted_lat IS NOT NULL
           AND a.extracted_lng IS NOT NULL
           AND a.location_text IS NOT NULL
           AND a.location_text <> ''
         GROUP BY 1, 2, 3
         ORDER BY n DESC
         LIMIT 1
    """
    with conn.cursor() as cur:
        cur.execute(sql, (event_id, CREDIBLE_RELIABILITY))
        row = cur.fetchone()
        if not row:
            return None
        v = list(row.values()) if isinstance(row, dict) else list(row)
        return {"place": v[0], "lat": float(v[1]), "lng": float(v[2]), "articles": int(v[3])}


def geocode_place(place: str, country_hint: Optional[str] = None) -> Optional[dict]:
    """Geocode a place named in a headline (Nominatim, throttled).

    Uses the module-level one-shot geocoder rather than the batch Geocoder
    class (which spins up a thread pool we do not need for a handful of
    places). Nominatim asks for >= 1 req/sec, so we sleep between calls.
    """
    if not place:
        return None
    try:
        import httpx
        from .geocode import geocode_one
    except Exception:  # noqa: BLE001 — geocoding is optional
        return None
    try:
        with httpx.Client(timeout=15) as client:
            # Try the bare place first: the country hint often comes from a
            # mis-filed article and would force the wrong "Georgia".
            hit = geocode_one(client, place, None)
            if not hit and country_hint:
                hit = geocode_one(client, place, country_hint)
        if not hit:
            return None
        time.sleep(1.2)  # Nominatim usage policy
        return {
            "place_name": hit.get("place_name") or place,
            "country": hit.get("country") or "",
            "lat": float(hit["lat"]),
            "lng": float(hit["lng"]),
        }
    except Exception as exc:  # noqa: BLE001
        print(f"[digest] geocode failed for {place!r}: {exc}", file=sys.stderr)
        return None


def fetch_previous_stories(path: str) -> set[int]:
    """Event ids used in the previous digest, so we don't repeat yesterday."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except (OSError, ValueError):
        return set()
    return {int(s["event_id"]) for s in prev.get("stories", []) if "event_id" in s}


# ── scoring ─────────────────────────────────────────────────────────────────

def score_candidates(cands: list[dict], stats: dict[int, dict],
                     graph: dict[int, int], now: datetime,
                     repeat_ids: set[int]) -> list[dict]:
    """Blend the signals into one 0..100 score per candidate."""
    if not cands:
        return []

    max_vel = max((float(c["velocity_score"] or 0) for c in cands), default=1.0) or 1.0
    max_acc = max((float(c["acceleration_6h"] or 0) for c in cands), default=1.0) or 1.0

    scored: list[dict] = []
    for c in cands:
        eid = int(c["id"])
        st = stats.get(eid, {})
        articles = int(st.get("articles") or c["articles_24h"] or 0)
        outlets = int(st.get("credible_outlets") or st.get("outlets") or 0)
        countries = int(c["countries_24h"] or st.get("outlet_countries") or 0)
        syndicated = int(c["syndicated_copies"] or 0)

        first_at = c["first_article_at"] or c["first_reported_at"]
        hours_old = 999.0
        if first_at:
            hours_old = max(0.0, (now - first_at).total_seconds() / 3600.0)

        signals = {
            "momentum": _norm(float(c["velocity_score"] or 0), max_vel),
            "acceleration": _norm(float(c["acceleration_6h"] or 0), max_acc),
            "corroboration": _norm(outlets, 12),
            "spread": _norm(countries, 8),
            "novelty": math.exp(-hours_old / 48.0) if hours_old < 999 else 0.0,
            "undercoverage": (
                (1.0 - min(1.0, outlets / 10.0)) * _norm(float(c["velocity_score"] or 0), 120)
            ),
            "graph": _norm(float(graph.get(eid, 0)), 40),
            "independence": 1.0 - min(1.0, syndicated / max(articles, 1)),
        }

        total = sum(WEIGHTS[k] * signals[k] for k in WEIGHTS)

        # Repetition penalty: yesterday's pick is not today's story.
        repeat_penalty = 0.35 if eid in repeat_ids else 0.0
        # A story with almost no independent reporting is not worth a slot.
        if outlets < MIN_OUTLETS:
            total *= 0.5
        # Junk headlines (css fragments, very short) get pushed down.
        headline = _clean_headline(c["headline"])
        if len(headline) < 25:
            total *= 0.6

        c["headline"] = headline
        c["signals"] = {k: round(v, 4) for k, v in signals.items()}
        c["raw_score"] = round(total, 4)
        c["score"] = round(max(0.0, total - repeat_penalty) * 100, 2)
        c["category"] = category_of(c["event_type"])
        c["hours_old"] = round(hours_old, 2)
        c["outlets"] = outlets
        c["countries"] = countries
        c["articles"] = articles
        c["linked_events"] = int(graph.get(eid, 0))
        c["outlet_names"] = st.get("credible_names", [])
        scored.append(c)

    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored


def passes_world_test(cand: dict) -> bool:
    """Does this look like a *world* story, by the numbers alone?

    Two conditions:
      * enough independent credible outlets (not one story copied 40 times)
      * reach: more than one country, OR a lot of outlets in one country

    This is what separates the Kyiv missile strike from a Zagreb football
    result and from a Czech president's trip to Algiers (75 articles, 6
    outlets, 1 country).
    """
    outlets = int(cand.get("outlets") or 0)
    countries = int(cand.get("countries") or 0)
    if outlets < MIN_CREDIBLE_OUTLETS:
        return False
    return countries >= MIN_COUNTRIES or outlets >= MANY_OUTLETS


def is_duplicate(a: dict, b: dict, stats: dict[int, dict],
                 dup_pairs: set[tuple[int, int]]) -> bool:
    """Are these two events the same story?"""
    aid, bid = int(a["id"]), int(b["id"])
    if (min(aid, bid), max(aid, bid)) in dup_pairs:
        return True
    a_arts = stats.get(aid, {}).get("article_ids") or set()
    b_arts = stats.get(bid, {}).get("article_ids") or set()
    if a_arts and b_arts:
        smaller = min(len(a_arts), len(b_arts))
        if smaller >= 2:
            overlap = len(a_arts & b_arts) / smaller
            if overlap >= DUPLICATE_ARTICLE_OVERLAP:
                return True
    return False


def diversify(scored: list[dict], n: int, stats: Optional[dict] = None,
              dup_pairs: Optional[set] = None) -> list[dict]:
    """Greedy editor pass: cap category / country / region repetition.

    Duplicates are only rejected here, at selection time — de-duplicating
    the whole pool first throws away most of the good candidates, because
    one big wire story legitimately lives in several clusters.
    """
    stats = stats or {}
    dup_pairs = dup_pairs or set()
    chosen: list[dict] = []
    per_cat: dict[str, int] = {}
    per_country: dict[str, int] = {}
    per_region: dict[str, int] = {}

    def region_of(country: Optional[str]) -> str:
        code = (country or "").strip().upper()
        return COUNTRY_REGION.get(code, code[:1] or "?")

    def pick(cand: dict, enforce_caps: bool) -> bool:
        cat = cand["category"]
        country = (cand.get("country") or "?").upper()
        region = region_of(cand.get("country"))
        if enforce_caps:
            if per_cat.get(cat, 0) >= MAX_PER_CATEGORY:
                return False
            if per_country.get(country, 0) >= MAX_PER_COUNTRY:
                return False
            if per_region.get(region, 0) >= MAX_PER_REGION:
                return False
        for other in chosen:
            if is_duplicate(cand, other, stats, dup_pairs):
                return False
        chosen.append(cand)
        per_cat[cat] = per_cat.get(cat, 0) + 1
        per_country[country] = per_country.get(country, 0) + 1
        per_region[region] = per_region.get(region, 0) + 1
        return True

    for cand in scored:
        if len(chosen) >= n:
            break
        pick(cand, enforce_caps=True)

    # If the variety caps left us short, top up with the best leftovers
    # (still duplicate-free).
    if len(chosen) < n:
        for cand in scored:
            if len(chosen) >= n:
                break
            if any(cand["id"] == c["id"] for c in chosen):
                continue
            pick(cand, enforce_caps=False)
    return chosen


# ── the model writes the "why" ─────────────────────────────────────────────

JUDGE_SYSTEM = """You write the copy for a daily global-news digest on a news map.

You get ONE story plus its measured signals. Reply with JSON only.

"international" — "yes" only if an international news audience would care
about this TODAY. A local ceremony, a sports result, a company press
release, a community notice, a sponsored project or a routine announcement
is "no". Answer "no" unless the story has consequences beyond its local
area (deaths, war, disaster, politics, major money, science, rights).

"interest" — 0-10, how much a curious, informed viewer would want to hear
about it today. Judge the STORY, not the volume. A heavily covered story
from three days ago is NOT interesting. A first report from an hour ago can
be.

"why" — ONE sentence, max 20 words, saying what makes it matter NOW.
  It must name something specific to THIS story (a fact, a number, a
  first report, an absence of response). Never write a sentence that
  could fit any story, and never reuse wording from these instructions.

"narration" — ONE spoken sentence, max 28 words, the way a host would say
it on camera. Lead with what happened, then why it matters. No meta
language ("this news item", "for viewers", "the story"). No repeated
headline. If the headline is not in English, describe the story in English.

"category" — exactly one of: conflict, politics, climate, economy, tech,
health, science, culture, society, other

"headline_en" — the headline in English. If the headline is already in
English, repeat it unchanged. If it is in another language, translate it
faithfully and briefly. Do not add information that is not in the headline.

"place" — the place the story HAPPENED, exactly as the headline names it
("Belgrade", "Kyiv", "Saudi Arabia"), or "" if the headline names no place.
Do not use the reporting location; use where the event occurred.

NEVER invent facts, numbers, names or places that are not in the input.

Reply with JSON only, no prose, no code fence:
{"international": "yes", "interest": 0, "why": "...", "narration": "...",
 "category": "...", "headline_en": "...", "place": "..."}"""


def _judge_prompt(cand: dict) -> str:
    sig = cand.get("signals", {})
    names = ", ".join(cand.get("outlet_names", [])[:6])
    return (
        f"HEADLINE: {cand.get('headline','')}\n"
        f"SUMMARY: {(cand.get('summary') or '')[:400]}\n"
        f"CATEGORY: {cand.get('category')} ({cand.get('event_type')})\n"
        f"PLACE: {cand.get('place_name') or 'unknown'}, {cand.get('country') or '??'}\n"
        f"REPORTING: {cand.get('outlets',0)} independent outlets in {cand.get('countries',0)} "
        f"countries, {cand.get('articles',0)} articles\n"
        f"OUTLETS: {names}\n"
        f"HOURS SINCE FIRST REPORT: {cand.get('hours_old')}\n"
        f"SIGNALS: acceleration={sig.get('acceleration')} corroboration={sig.get('corroboration')} "
        f"novelty={sig.get('novelty')} undercoverage={sig.get('undercoverage')} "
        f"connected_events={cand.get('linked_events',0)}\n"
    )


def _parse_json_reply(raw: str) -> Optional[dict]:
    """Pull the JSON object out of a model reply (tolerates fences/prose)."""
    if not raw:
        return None
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _trim_sentence(text: str, max_chars: int) -> str:
    """Cut to a sentence boundary so a truncated line never ends mid-word."""
    text = (text or "").strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    for sep in (". ", "! ", "? "):
        idx = cut.rfind(sep)
        if idx > 0:
            return cut[: idx + 1].strip()
    return cut.rsplit(" ", 1)[0].strip()


META_PHRASES = (
    "for viewers", "this news item", "the story is important", "for the audience",
    "this article", "news consumers", "worth noting that", "it is worth",
)


def _clean_copy(text: str) -> str:
    """Drop meta-language and empty placeholders the model sometimes emits."""
    text = (text or "").strip()
    if text in ("...", "..", "-", "n/a", "none", "null"):
        return ""
    low = text.lower()
    for phrase in META_PHRASES:
        if phrase in low:
            return ""
    return text


async def _judge_one(cand: dict, sem: asyncio.Semaphore) -> dict:
    from .ai_client import ai_chat_stream

    prompt = _judge_prompt(cand)
    async with sem:
        for attempt in range(2):
            raw = ""
            try:
                async for line in ai_chat_stream(
                    [{"role": "system", "content": JUDGE_SYSTEM},
                     {"role": "user", "content": prompt}],
                    temperature=0.5 if attempt == 0 else 0.2,
                    max_tokens=260,
                ):
                    if line == "[DONE]":
                        break
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if delta:
                        raw += delta
                data = _parse_json_reply(raw)
                if data is not None and not _clean_copy(str(data.get("why", "") or "")):
                    data = None  # no usable copy — retry once
                if data is not None:
                    cat = str(data.get("category", "")).strip().lower()
                    head_en = str(data.get("headline_en", "") or "").strip()
                    if head_en:
                        head_en = _trim_sentence(head_en, 220)
                    international = str(data.get("international", "")).strip().lower()
                    return {
                        "international": "yes" if international in ("yes", "true", "y") else "no",
                        "interest": max(0.0, min(10.0, float(data.get("interest", 5) or 0))),
                        "why": _clean_copy(_trim_sentence(str(data.get("why", "")), 200)),
                        "narration": _clean_copy(_trim_sentence(str(data.get("narration", "")), 260)),
                        "category": cat if cat in CATEGORIES else "",
                        "headline_en": head_en,
                        "place": str(data.get("place", "") or "").strip()[:120],
                    }
            except Exception as exc:  # noqa: BLE001 — a failed judgement must not kill the run
                print(f"[digest] AI judgement error for event {cand.get('id')}: {exc}",
                      file=sys.stderr)
                if "429" in str(exc):
                    await asyncio.sleep(6)
            if attempt == 0:
                prompt = _judge_prompt(cand) + "\n\nIMPORTANT: reply with the JSON object only."
    return {}


DESK_SYSTEM = """You are a news editor at an international wire desk (Reuters / AP /
Al Jazeera). You decide what goes on the global front page.

Which of these two describes the story BEST?

A) A significant event happened — an attack, a disaster, a decision by a
   government or company that has consequences, a ruling, a scientific
   finding, an election result that matters, a large death toll.

B) A routine update — something scheduled or ceremonial, a sports result,
   an award or a shortlist, someone attending a conference, a company
   press release, a sponsored project, a community notice, a profile or
   human-interest feature, a shopping or lifestyle piece, speculation about
   what might happen, or an opinion.

A story is A if it reports something that HAPPENED with consequences
beyond the place it happened. Choose A for war, attacks, casualties,
disasters, earthquakes, government decisions, major money, science,
rights and health emergencies. Choose B for everything else.

Answer with exactly one letter: A or B."""


async def _desk_check(cand: dict, sem: asyncio.Semaphore) -> bool:
    """A second, narrow opinion: is this an *event* or just routine?

    Small models are far more reliable answering one narrow multiple-choice
    question than filling in a multi-field JSON form, so this is the gate
    that decides what makes the digest.
    """
    from .ai_client import ai_chat_stream

    headline = cand.get("headline_en") or cand.get("headline") or ""
    async with sem:
        for attempt in range(2):
            raw = ""
            try:
                async for line in ai_chat_stream(
                    [{"role": "system", "content": DESK_SYSTEM},
                     {"role": "user", "content": f"Story: {headline}\\n\\n"
                                                f"Answer A or B."}],
                    temperature=0.1,
                    max_tokens=4,
                ):
                    if line == "[DONE]":
                        break
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if delta:
                        raw += delta
                verdict = raw.strip().upper()
                if verdict.startswith("A"):
                    return True
                if verdict.startswith("B"):
                    return False
            except Exception as exc:  # noqa: BLE001
                print(f"[digest] desk check error for {cand.get('id')}: {exc}", file=sys.stderr)
                if "429" in str(exc):
                    await asyncio.sleep(6)
            if attempt == 0:
                await asyncio.sleep(0.5)
    return True  # if the desk check cannot answer, do not veto


async def judge_with_ai(cands: list[dict], concurrency: int = 2) -> list[dict]:
    """Ask the local model to write the copy for each candidate.

    The model does NOT decide what makes the digest — the measured signals
    do that. It writes the "why" and the narration, and it may veto a
    story (interest below AI_VETO_INTEREST) that turns out to be nothing.
    """
    sem = asyncio.Semaphore(concurrency)
    results = await asyncio.gather(*[_judge_one(c, sem) for c in cands])
    out = []
    for cand, verdict in zip(cands, results):
        cand = dict(cand)
        if verdict:
            cand["international"] = verdict.get("international", "yes")
            cand["interest"] = verdict.get("interest", 5.0)
            cand["why"] = verdict.get("why", "")
            cand["narration"] = verdict.get("narration", "")
            if verdict.get("category"):
                cand["ai_category"] = verdict["category"]
                cand["category"] = verdict["category"]
            if verdict.get("headline_en"):
                cand["headline_en"] = verdict["headline_en"]
            if verdict.get("place"):
                cand["ai_place"] = verdict["place"]
            # A gentle nudge only: the measured signals stay in charge.
            cand["score"] = round(cand["score"] * 0.85 + cand["interest"] * 10 * 0.15, 2)
        else:
            cand.setdefault("international", "yes")
            cand.setdefault("interest", 5.0)
            cand.setdefault("why", "")
            cand.setdefault("narration", "")
        out.append(cand)

    # Second opinion: the wire-desk A/B opinion is a SOFT score, not a
    # veto: a small model mis-vetoing a good story loses it forever, while
    # a soft penalty only demotes it.
    desk = await asyncio.gather(*[_desk_check(c, sem) for c in out])
    for cand, passed in zip(out, desk):
        cand["desk_pass"] = bool(passed)
        cand["score"] = round(cand["score"] + (4 if passed else -9), 2)
    out.sort(key=lambda c: c["score"], reverse=True)
    return out


def fallback_copy(cand: dict) -> None:
    """Guarantee every story has a why and a narration.

    The video reads these; a hole in the script is a hole in the video, so
    anything the model failed to write is filled from the measured
    signals rather than left blank.
    """
    if not (cand.get("why") or "").strip():
        outlets = int(cand.get("outlets") or 0)
        countries = int(cand.get("countries") or 0)
        hours = cand.get("hours_old")
        parts = []
        if hours is not None and hours < 6:
            parts.append("first reported less than six hours ago")
        elif hours is not None:
            parts.append(f"first reported {int(hours)} hours ago")
        if outlets:
            parts.append(f"picked up by {outlets} outlets in {countries} countries")
        cand["why"] = ("; ".join(parts).capitalize() + ".") if parts else ""

    if not (cand.get("narration") or "").strip():
        head = cand.get("headline_en") or cand.get("headline") or ""
        cand["narration"] = _trim_sentence(head, 240) if head else ""


async def fill_missing_copy(cands: list[dict], concurrency: int = 2) -> None:
    """Second pass for stories the model left without copy."""
    missing = [c for c in cands
               if not (c.get("why") or "").strip() or not (c.get("narration") or "").strip()]
    if not missing:
        return
    print(f"[digest] {len(missing)} stories have no copy — asking the model again",
          file=sys.stderr)
    sem = asyncio.Semaphore(concurrency)
    results = await asyncio.gather(*[_judge_one(c, sem) for c in missing])
    for cand, verdict in zip(missing, results):
        if not verdict:
            continue
        if not (cand.get("why") or "").strip():
            cand["why"] = verdict.get("why", "")
        if not (cand.get("narration") or "").strip():
            cand["narration"] = verdict.get("narration", "")
        if not (cand.get("headline_en") or "").strip() and verdict.get("headline_en"):
            cand["headline_en"] = verdict["headline_en"]


# ── digest assembly ────────────────────────────────────────────────────────

def build_story(cand: dict, rank: int, sample_articles: list[dict]) -> dict:
    return {
        "rank": rank,
        "event_id": int(cand["id"]),
        "headline": cand.get("headline", ""),
        "headline_en": cand.get("headline_en", ""),
        "summary": (cand.get("summary") or "")[:400],
        "why": cand.get("why", ""),
        "narration": cand.get("narration", ""),
        "interest": cand.get("interest"),
        "international": cand.get("international"),
        "category": cand.get("category"),
        "event_type": cand.get("event_type"),
        "place": cand.get("place_name"),
        "ai_place": cand.get("ai_place", ""),
        "country": cand.get("country"),
        "lat": cand.get("lat"),
        "lng": cand.get("lng"),
        "score": cand.get("score"),
        "signals": cand.get("signals", {}),
        "hours_old": cand.get("hours_old"),
        "outlets": cand.get("outlets", 0),
        "countries": cand.get("countries", 0),
        "articles": cand.get("articles", 0),
        "linked_events": cand.get("linked_events", 0),
        "outlet_names": cand.get("outlet_names", [])[:8],
        "sources": sample_articles,
    }


def build_digest(stories: list[dict], window_hours: int, generated_at: datetime) -> dict:
    return {
        "version": 1,
        "generated_at": generated_at.isoformat(),
        "window_hours": window_hours,
        "story_count": len(stories),
        "stories": stories,
    }


def print_preview(digest: dict) -> None:
    print()
    print(f"  DAILY DIGEST — {digest['generated_at'][:16]}  "
          f"(window {digest['window_hours']}h, {digest['story_count']} stories)")
    print("  " + "─" * 78)
    for s in digest["stories"]:
        print(f"  #{s['rank']:<2} [{s['score']:>6.1f}] {s['category']:<9} "
              f"{s.get('place') or '—'}, {s.get('country') or '??'}")
        head = s.get("headline_en") or s["headline"]
        print(f"      {head[:100]}")
        if s.get("headline_en") and s.get("headline") and s["headline_en"] != s["headline"]:
            print(f"      ({s['headline'][:90]})")
        if s.get("why"):
            print(f"      why: {s['why']}")
        if s.get("narration"):
            print(f"      say: {s['narration']}")
        print(f"      {s['outlets']} outlets / {s['countries']} countries / "
              f"{s['articles']} articles / {s.get('hours_old')}h old")
        print()


# ── main ────────────────────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Build the daily news digest")
    ap.add_argument("--hours", type=int, default=DEFAULT_WINDOW_HOURS,
                    help="look-back window in hours (default 24)")
    ap.add_argument("--stories", type=int, default=DEFAULT_STORIES,
                    help=f"how many stories to pick (default {DEFAULT_STORIES})")
    ap.add_argument("--out", default=DEFAULT_OUT_PATH, help="output JSON path")
    ap.add_argument("--dry-run", action="store_true", help="do not write the file")
    ap.add_argument("--print", dest="show", action="store_true", help="human-readable preview")
    ap.add_argument("--no-ai", action="store_true", help="skip the model calls")
    ap.add_argument("--json", action="store_true", help="dump the JSON to stdout")
    args = ap.parse_args(argv)

    now = datetime.now(timezone.utc)
    repeat_ids = fetch_previous_stories(args.out)

    with connect() as conn:
        cands = fetch_candidates(conn, args.hours, CANDIDATE_POOL)
        if not cands:
            _log("no candidates — nothing to digest")
            return 1

        # 1. drop non-news (shopping listicles, press releases, ...)
        before = len(cands)
        cands = [c for c in cands if not is_promotional(_clean_headline(c["headline"]))]
        _log(f"{before - len(cands)} non-news headlines filtered out")

        ids = [int(c["id"]) for c in cands]
        stats = fetch_outlet_stats(conn, ids)
        graph = fetch_graph_links(conn, ids)
        dup_pairs = fetch_duplicate_pairs(conn, ids)
        _log(f"{len(dup_pairs)} duplicate event pairs detected in the story graph")

    # 2. score on the measured signals only — the editor, not the model
    scored = score_candidates(cands, stats, graph, now, repeat_ids)

    # 2b. the world test: independent corroboration and reach
    before_world = len(scored)
    scored = [c for c in scored if passes_world_test(c)]
    _log(f"{before_world - len(scored)} candidates failed the world test "
         f"(corroboration/reach) — {len(scored)} left")

    # 3. keep the pool intact — duplicates are rejected at selection time
    scored = scored[:SHORTLIST]

    # 4. the model writes the copy (and may veto); the signals still decide
    if not args.no_ai and scored:
        pool = scored[: min(AI_MAX_POOL, max(args.stories * AI_POOL_MULTIPLIER, args.stories + 24))]
        _log(f"asking the local model to write copy for {len(pool)} candidates ...")
        pool = asyncio.run(judge_with_ai(pool))
        _log(f"{len(pool)} candidates survived the model's gates")
        # Hard rule: only editorially relevant categories. "other" means the
        # model could not classify the story — exactly what we do not want.
        editorial = [c for c in pool if c.get("category") in EDITORIAL_CATEGORIES]
        _log(f"{len(editorial)} of {len(pool)} candidates are in the editorial categories")
        pool = editorial or pool
        scored = pool

    # 5. the editor's variety pass (also rejects duplicates)
    scored = diversify(scored, args.stories, stats, dup_pairs)
    scored = scored[: args.stories]

    # 5b. every story must have copy the video can read
    if not args.no_ai and scored:
        asyncio.run(fill_missing_copy(scored))
    for c in scored:
        fallback_copy(c)

    with connect() as conn:
        stories = []
        for i, c in enumerate(scored):
            # The article locations can be wrong (a Belgrade story filed under
            # Tokyo). Prefer the place the model read out of the headline,
            # geocoded; fall back to the modal article location.
            ai_place = (c.get("ai_place") or "").strip()
            if ai_place:
                loc = geocode_place(ai_place, c.get("country"))
                if loc:
                    c["place_name"] = loc["place_name"]
                    c["lat"] = loc["lat"]
                    c["lng"] = loc["lng"]
                    if loc.get("country"):
                        code = normalize_country(str(loc["country"]))
                        # Only override when the name actually maps to a code
                        # (Nominatim localises country names).
                        if code and len(code) == 2 and code.isalpha():
                            c["country"] = code.upper()
                    c["place_source"] = "headline"
            if not c.get("place_source"):
                loc = fetch_story_location(conn, int(c["id"]))
                if loc:
                    c["place_name"] = loc["place"]
                    c["lat"] = loc["lat"]
                    c["lng"] = loc["lng"]
                    c["place_source"] = "articles"
            stories.append(build_story(c, i + 1, fetch_sample_articles(conn, int(c["id"]))))

    digest = build_digest(stories, args.hours, now)

    if args.show or args.dry_run:
        print_preview(digest)
    if args.json:
        print(json.dumps(digest, indent=1, ensure_ascii=False))

    if not args.dry_run:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(digest, fh, indent=1, ensure_ascii=False)
        _log(f"wrote {args.out} ({len(stories)} stories)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
