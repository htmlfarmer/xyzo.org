"""Xyzo learning loop — observes past cycles and rewrites the
fetch policy for the next one.

Three sub-systems, all invoked by `run.sh --step learn`:

  1. update_priorities()    bandit-style score → news_sources.reliability_score
                            + news_sources.poll_interval_s, decisions logged
                            to news_fetch_decisions.

  2. detect_coverage_gaps() scores every country on
                            events_per_million vs. population, writes
                            news_coverage_gaps, and applies a tier-boost
                            to sources from high-gap countries.

  3. feedback_extraction()  inspects recent news_articles for recurring
                            extraction issues (geocode failures,
                            country-name mismatches, no-cluster) and
                            logs them to news_extraction_feedback so
                            prompt tuning has a labeled signal.

Run directly:
    python -m worker.learn                      # all three
    python -m worker.learn --only priorities
    python -m worker.learn --only gaps
    python -m worker.learn --only extraction

The module writes directly to news_sources, matching the user's
preference for "direct DB updates" with full audit logs.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import statistics
import uuid
from datetime import datetime, timezone
from typing import Any

from .db import connect
from .source_cadence import calculate_and_update_cadence

log = logging.getLogger("xyzo.learn")


# ── Country reference table ──────────────────────────────────────────
# Population in millions, approximate 2024 figures. Used to score
# coverage gaps. Not authoritative — adjust as needed.
COUNTRY_POPULATION: dict[str, dict[str, Any]] = {
    "CN": {"name": "China",                "pop": 1410, "region": "asia"},
    "IN": {"name": "India",                "pop": 1430, "region": "asia"},
    "US": {"name": "United States",        "pop":  335, "region": "americas"},
    "ID": {"name": "Indonesia",            "pop":  277, "region": "asia"},
    "PK": {"name": "Pakistan",             "pop":  240, "region": "asia"},
    "BR": {"name": "Brazil",               "pop":  216, "region": "americas"},
    "NG": {"name": "Nigeria",              "pop":  223, "region": "africa"},
    "BD": {"name": "Bangladesh",           "pop":  173, "region": "asia"},
    "RU": {"name": "Russia",               "pop":  144, "region": "europe"},
    "MX": {"name": "Mexico",               "pop":  130, "region": "americas"},
    "JP": {"name": "Japan",                "pop":  124, "region": "asia"},
    "PH": {"name": "Philippines",          "pop":  117, "region": "asia"},
    "ET": {"name": "Ethiopia",             "pop":  126, "region": "africa"},
    "EG": {"name": "Egypt",                "pop":  112, "region": "africa"},
    "VN": {"name": "Vietnam",              "pop":  100, "region": "asia"},
    "CD": {"name": "DR Congo",             "pop":  102, "region": "africa"},
    "TR": {"name": "Türkiye",              "pop":   85, "region": "asia"},
    "IR": {"name": "Iran",                 "pop":   89, "region": "asia"},
    "DE": {"name": "Germany",              "pop":   84, "region": "europe"},
    "TH": {"name": "Thailand",             "pop":   72, "region": "asia"},
    "GB": {"name": "United Kingdom",       "pop":   67, "region": "europe"},
    "FR": {"name": "France",               "pop":   68, "region": "europe"},
    "IT": {"name": "Italy",                "pop":   59, "region": "europe"},
    "TZ": {"name": "Tanzania",             "pop":   67, "region": "africa"},
    "ZA": {"name": "South Africa",         "pop":   60, "region": "africa"},
    "MM": {"name": "Myanmar",              "pop":   55, "region": "asia"},
    "KE": {"name": "Kenya",                "pop":   55, "region": "africa"},
    "KR": {"name": "South Korea",          "pop":   52, "region": "asia"},
    "CO": {"name": "Colombia",             "pop":   52, "region": "americas"},
    "ES": {"name": "Spain",                "pop":   48, "region": "europe"},
    "AR": {"name": "Argentina",            "pop":   46, "region": "americas"},
    "DZ": {"name": "Algeria",              "pop":   45, "region": "africa"},
    "SD": {"name": "Sudan",                "pop":   47, "region": "africa"},
    "IQ": {"name": "Iraq",                 "pop":   45, "region": "asia"},
    "AF": {"name": "Afghanistan",          "pop":   42, "region": "asia"},
    "PL": {"name": "Poland",               "pop":   41, "region": "europe"},
    "CA": {"name": "Canada",               "pop":   40, "region": "americas"},
    "MA": {"name": "Morocco",              "pop":   38, "region": "africa"},
    "SA": {"name": "Saudi Arabia",         "pop":   36, "region": "asia"},
    "UA": {"name": "Ukraine",              "pop":   37, "region": "europe"},
    "UZ": {"name": "Uzbekistan",           "pop":   35, "region": "asia"},
    "PE": {"name": "Peru",                 "pop":   34, "region": "americas"},
    "AO": {"name": "Angola",               "pop":   36, "region": "africa"},
    "MY": {"name": "Malaysia",             "pop":   34, "region": "asia"},
    "AFG": {"name": "Afghanistan (legacy)","pop":   42, "region": "asia"},
    "GH": {"name": "Ghana",                "pop":   33, "region": "africa"},
    "MZ": {"name": "Mozambique",           "pop":   33, "region": "africa"},
    "YE": {"name": "Yemen",                "pop":   33, "region": "asia"},
    "NP": {"name": "Nepal",                "pop":   30, "region": "asia"},
    "VE": {"name": "Venezuela",            "pop":   29, "region": "americas"},
    "PG": {"name": "Papua New Guinea",     "pop":   10, "region": "oceania"},
    "AU": {"name": "Australia",            "pop":   26, "region": "oceania"},
    "FJ": {"name": "Fiji",                 "pop":    0.9, "region": "oceania"},
    "SB": {"name": "Solomon Islands",      "pop":    0.7, "region": "oceania"},
    "VU": {"name": "Vanuatu",              "pop":    0.33, "region": "oceania"},
    "WS": {"name": "Samoa",                "pop":    0.2, "region": "oceania"},
    "TO": {"name": "Tonga",                "pop":    0.1, "region": "oceania"},
    "KI": {"name": "Kiribati",             "pop":    0.12, "region": "oceania"},
    "TV": {"name": "Tuvalu",               "pop":    0.012, "region": "oceania"},
    "NR": {"name": "Nauru",                "pop":    0.012, "region": "oceania"},
    "FM": {"name": "Micronesia",           "pop":    0.12, "region": "oceania"},
    "MH": {"name": "Marshall Islands",     "pop":    0.06, "region": "oceania"},
    "PW": {"name": "Palau",                "pop":    0.018, "region": "oceania"},
    "CK": {"name": "Cook Islands",         "pop":    0.015, "region": "oceania"},
    "NZ": {"name": "New Zealand",          "pop":    5.1, "region": "oceania"},
    "HK": {"name": "Hong Kong",            "pop":    7, "region": "asia"},
    "SG": {"name": "Singapore",            "pop":    6, "region": "asia"},
    "QA": {"name": "Qatar",                "pop":    3, "region": "asia"},
    "PS": {"name": "Palestine",            "pop":    5, "region": "asia"},
    "IE": {"name": "Ireland",              "pop":    5, "region": "europe"},
}


# ── Tier assignment ──────────────────────────────────────────────────
# Map a 0..1 score to a tier and a poll interval. Slightly more
# granular than the legacy hardcoded fast_update.PRIORITY_LEVELS so we
# can pull hot sources tighter and cool off cold ones.
TIER_TABLE = [
    # (min_score, tier,         default_interval_s,  max_articles_per_cycle)
    (0.75, "critical", 600,  30),
    (0.50, "high",     1200, 20),
    (0.25, "medium",   1800, 15),
    (0.05, "low",      3600, 10),
    (-1.0, "paused",   86400, 0),
]


def _tier_for(score: float, *, error_count: int, active: bool) -> tuple[str, int, int]:
    if not active:
        return "paused", 86400, 0
    if error_count >= 10:
        return "paused", 86400, 0
    for min_score, tier, interval, cap in TIER_TABLE:
        if score >= min_score:
            return tier, interval, cap
    return "paused", 86400, 0


# ── Country name normalization ───────────────────────────────────────
# The extractor sometimes returns "United States" or "中国" instead of
# ISO-3166-1 alpha-2 codes. Normalize on the way in so gap math works.
COUNTRY_NAME_TO_ISO: dict[str, str] = {
    "united states": "US", "usa": "US", "u.s.": "US", "u.s.a.": "US", "america": "US",
    "united kingdom": "GB", "uk": "GB", "britain": "GB", "great britain": "GB", "england": "GB",
    "中国": "CN", "china": "CN", "prc": "CN", "people's republic of china": "CN",
    "日本": "JP", "japan": "JP",
    "deutschland": "DE", "germany": "DE",
    "france": "FR",
    "españa": "ES", "spain": "ES",
    "italia": "IT", "italy": "IT",
    "укрaïна": "UA", "ukraine": "UA",
    "россия": "RU", "russia": "RU",
    "brasil": "BR", "brazil": "BR",
    "india": "IN",
    "mexico": "MX", "méxico": "MX",
    "canada": "CA",
    "israel": "IL", "ישראל": "IL",
    "palestine": "PS", "الأراضي الفلسطينية": "PS", "palestinian territories": "PS",
    "australia": "AU",
    "south korea": "KR", "korea": "KR", "republic of korea": "KR",
    "north korea": "KP",
    "ireland": "IE", "éire": "IE", "éire / ireland": "IE",
    "sweden": "SE", "sverige": "SE",
    "norway": "NO", "norge": "NO",
    "denmark": "DK", "danmark": "DK",
    "finland": "FI", "suomi": "FI",
    "poland": "PL", "polska": "PL",
    "czechia": "CZ", "česko": "CZ", "czech republic": "CZ",
    "slovakia": "SK", "slovensko": "SK",
    "switzerland": "CH", "schweiz/suisse/svizzera/svizra": "CH",
    "netherlands": "NL", "holland": "NL",
    "belgium": "BE", "belgique": "BE",
    "austria": "AT", "österreich": "AT",
    "portugal": "PT",
    "greece": "GR", "ελλάδα": "GR",
    "turkey": "TR", "türkiye": "TR",
    "iran": "IR",
    "iraq": "IQ",
    "saudi arabia": "SA",
    "uae": "AE", "united arab emirates": "AE",
    "egypt": "EG", "مصر": "EG",
    "pakistan": "PK",
    "bangladesh": "BD",
    "indonesia": "ID",
    "philippines": "PH",
    "vietnam": "VN", "việt nam": "VN",
    "thailand": "TH", "ประเทศไทย": "TH",
    "malaysia": "MY",
    "singapore": "SG",
    "hong kong": "HK",
    "taiwan": "TW",
    "japan": "JP",
    "south africa": "ZA",
    "nigeria": "NG",
    "kenya": "KE",
    "ghana": "GH",
    "ethiopia": "ET",
    "morocco": "MA", "المغرب": "MA",
    "algeria": "DZ", "الجزائر": "DZ",
    "tunisia": "TN", "تونس": "TN",
    "libya": "LY",
    "sudan": "SD",
    "colombia": "CO",
    "venezuela": "VE",
    "peru": "PE", "perú": "PE",
    "argentina": "AR",
    "chile": "CL",
    "new zealand": "NZ", "aotearoa": "NZ",
    "iceland": "IS", "ísland": "IS",
    "luxembourg": "LU",
    "estonia": "EE", "eesti": "EE",
    "latvia": "LV", "latvija": "LV",
    "lithuania": "LT", "lietuva": "LT",
    "georgia": "GE", "საქართველო": "GE",
    "armenia": "AM", "հայաստան": "AM",
    "azerbaijan": "AZ",
    "kazakhstan": "KZ", "қазақстан": "KZ",
    "uzbekistan": "UZ", "oʻzbekiston": "UZ",
    "afghanistan": "AF",
    "yemen": "YE", "اليمن": "YE",
    "syria": "SY", "سوريا": "SY",
    "lebanon": "LB", "لبنان": "LB",
    "jordan": "JO", "الأردن": "JO",
    # Coverage for the user-supplied cities.csv (100k+ global set).
    # Keep this list alphabetized by English name.
    "albania": "AL", "shqipëria": "AL", "shqiperia": "AL",
    "algeria": "DZ",
    "angola": "AO",
    "antigua and barbuda": "AG",
    "argentina": "AR",
    "armenia": "AM",
    "australia": "AU",
    "austria": "AT",
    "azerbaijan": "AZ",
    "bahamas": "BS", "the bahamas": "BS",
    "bahrain": "BH",
    "bangladesh": "BD",
    "barbados": "BB",
    "belarus": "BY",
    "belgium": "BE",
    "belize": "BZ",
    "benin": "BJ",
    "bhutan": "BT",
    "bolivia": "BO",
    "bosnia and herzegovina": "BA", "bosnia": "BA", "herzegovina": "BA",
    "botswana": "BW",
    "brazil": "BR",
    "brunei": "BN",
    "bulgaria": "BG",
    "burkina faso": "BF",
    "burundi": "BI",
    "cambodia": "KH", "kampuchea": "KH",
    "cameroon": "CM", "cameroun": "CM",
    "canada": "CA",
    "cape verde": "CV", "cabo verde": "CV",
    "central african republic": "CF",
    "chad": "TD", "tchad": "TD",
    "chile": "CL",
    "china": "CN",
    "colombia": "CO",
    "comoros": "KM",
    "congo": "CG", "republic of the congo": "CG", "republic of congo": "CG",
    "democratic republic of the congo": "CD", "dr congo": "CD", "drc": "CD", "congo-kinshasa": "CD",
    "costa rica": "CR",
    "croatia": "HR", "hrvatska": "HR",
    "cuba": "CU",
    "curaçao": "CW", "curacao": "CW",
    "cyprus": "CY",
    "czechia": "CZ", "czech republic": "CZ",
    "denmark": "DK",
    "djibouti": "DJ",
    "dominica": "DM",
    "dominican republic": "DO",
    "ecuador": "EC",
    "egypt": "EG",
    "el salvador": "SV",
    "equatorial guinea": "GQ",
    "eritrea": "ER",
    "estonia": "EE",
    "eswatini": "SZ", "swaziland": "SZ",
    "ethiopia": "ET",
    "fiji": "FJ",
    "finland": "FI",
    "france": "FR",
    "gabon": "GA",
    "gambia": "GM", "the gambia": "GM",
    "georgia": "GE",
    "germany": "DE",
    "ghana": "GH",
    "greece": "GR",
    "grenada": "GD",
    "guatemala": "GT",
    "guinea": "GN",
    "guinea-bissau": "GW",
    "guyana": "GY",
    "haiti": "HT",
    "honduras": "HN",
    "hungary": "HU",
    "iceland": "IS",
    "india": "IN",
    "indonesia": "ID",
    "iran": "IR",
    "iraq": "IQ",
    "ireland": "IE",
    "israel": "IL",
    "italy": "IT",
    "ivory coast": "CI", "côte d'ivoire": "CI", "cote d'ivoire": "CI",
    "jamaica": "JM",
    "japan": "JP",
    "jordan": "JO",
    "kazakhstan": "KZ",
    "kenya": "KE",
    "kiribati": "KI",
    "kosovo": "XK",
    "kuwait": "KW",
    "kyrgyzstan": "KG",
    "laos": "LA",
    "latvia": "LV",
    "lebanon": "LB",
    "lesotho": "LS",
    "liberia": "LR",
    "libya": "LY",
    "liechtenstein": "LI",
    "lithuania": "LT",
    "luxembourg": "LU",
    "madagascar": "MG",
    "malawi": "MW",
    "malaysia": "MY",
    "maldives": "MV",
    "mali": "ML",
    "malta": "MT",
    "mauritania": "MR",
    "mauritius": "MU",
    "mexico": "MX",
    "moldova": "MD",
    "monaco": "MC",
    "mongolia": "MN",
    "montenegro": "ME", "crna gora": "ME",
    "morocco": "MA",
    "mozambique": "MZ", "moçambique": "MZ", "mocambique": "MZ",
    "myanmar": "MM", "burma": "MM", "မြန်မာ": "MM",
    "namibia": "NA",
    "nepal": "NP",
    "netherlands": "NL",
    "new zealand": "NZ",
    "nicaragua": "NI",
    "niger": "NE",
    "nigeria": "NG",
    "north korea": "KP", "dprk": "KP",
    "north macedonia": "MK", "macedonia": "MK",
    "norway": "NO",
    "oman": "OM",
    "pakistan": "PK",
    "palestine": "PS", "state of palestine": "PS",
    "panama": "PA",
    "papua new guinea": "PG",
    "paraguay": "PY",
    "peru": "PE",
    "philippines": "PH",
    "poland": "PL",
    "portugal": "PT",
    "qatar": "QA",
    "romania": "RO",
    "russia": "RU", "russian federation": "RU",
    "rwanda": "RW",
    "saint kitts and nevis": "KN",
    "saint lucia": "LC",
    "saint vincent and the grenadines": "VC",
    "samoa": "WS",
    "san marino": "SM",
    "sao tome and principe": "ST",
    "saudi arabia": "SA",
    "senegal": "SN",
    "serbia": "RS", "srbija": "RS",
    "seychelles": "SC",
    "sierra leone": "SL",
    "singapore": "SG",
    "slovakia": "SK",
    "slovenia": "SI",
    "solomon islands": "SB",
    "somalia": "SO",
    "somaliland": "SO",
    "south africa": "ZA",
    "south korea": "KR",
    "south sudan": "SS",
    "spain": "ES",
    "sri lanka": "LK", "ceylon": "LK",
    "sudan": "SD",
    "suriname": "SR",
    "sweden": "SE",
    "switzerland": "CH",
    "syria": "SY",
    "taiwan": "TW",
    "tajikistan": "TJ",
    "tanzania": "TZ",
    "thailand": "TH",
    "timor-leste": "TL", "east timor": "TL",
    "togo": "TG",
    "tonga": "TO",
    "trinidad and tobago": "TT",
    "tunisia": "TN",
    "turkey": "TR", "türkiye": "TR", "turkiye": "TR",
    "turkmenistan": "TM",
    "tuvalu": "TV",
    "uganda": "UG",
    "ukraine": "UA",
    "united arab emirates": "AE",
    "united kingdom": "GB",
    "united states": "US",
    "uruguay": "UY",
    "uzbekistan": "UZ",
    "vanuatu": "VU",
    "vatican city": "VA", "holy see": "VA",
    "venezuela": "VE",
    "vietnam": "VN",
    "yemen": "YE",
    "zambia": "ZM",
    "zimbabwe": "ZW",
}


def normalize_country(value: str | None) -> str | None:
    """Best-effort ISO normalization of a free-form country string."""
    if not value:
        return None
    v = value.strip().lower()
    if not v:
        return None
    if len(v) == 2 and v.isalpha():
        return v.upper()
    if v in COUNTRY_NAME_TO_ISO:
        return COUNTRY_NAME_TO_ISO[v]
    # Strip common suffixes.
    for suffix in (
        " (the)", " the", ", republic of", " republic of",
        " federal republic of", " kingdom of", " state of",
    ):
        if v.endswith(suffix):
            v2 = v[: -len(suffix)].strip()
            if v2 in COUNTRY_NAME_TO_ISO:
                return COUNTRY_NAME_TO_ISO[v2]
    # Substring match against the reference name list.
    for name, iso in COUNTRY_NAME_TO_ISO.items():
        if name in v or v in name:
            return iso
    return None


# ── 1. Source-priority learner ───────────────────────────────────────
def update_priorities(cycle_id: str) -> dict:
    """Score every active source, write tier+interval back, log decisions."""
    with connect() as conn, conn.cursor() as cur:
        # Snapshot current behavior so we can compute deltas for the audit log.
        cur.execute("""
            SELECT s.id, s.name, s.country, s.language, s.active,
                   s.error_count,
                   s.last_success_at,
                   s.reliability_score, s.poll_interval_s,
                   COUNT(a.id) FILTER (WHERE a.fetched_at > now() - interval '24 hours') AS articles_24h,
                   COUNT(a.id) FILTER (WHERE a.fetched_at > now() - interval '7 days')   AS articles_7d,
                   COUNT(DISTINCT es.event_id) FILTER (
                       WHERE es.created_at > now() - interval '24 hours'
                   ) AS events_24h
            FROM news_sources s
            LEFT JOIN news_articles a ON a.source_id = s.id
            LEFT JOIN news_event_sources es ON es.article_id = a.id
            GROUP BY s.id
        """)
        rows = cur.fetchall()

    if not rows:
        return {"sources": 0, "tiers": {}}

    # Normalize yield to 0..1 with log scaling so a single mega-source
    # doesn't dwarf everyone else.
    yields = [float(r["articles_24h"] or 0) for r in rows]
    if yields:
        max_y = max(yields) or 1.0
        log_max = math.log1p(max_y)
    else:
        log_max = 1.0

    # Compute composite score per source.
    scored: list[dict] = []
    for r in rows:
        yield_24h = int(r["articles_24h"] or 0)
        yield_7d = int(r["articles_7d"] or 0)
        events_24h = int(r["events_24h"] or 0)
        errors = int(r["error_count"] or 0)
        active = bool(r["active"])
        last_success = r["last_success_at"]
        prev_reliability = float(r["reliability_score"] or 0.5)
        prev_interval = int(r["poll_interval_s"] or 1800)

        # Yield component: log-scaled 24h article volume.
        yield_score = math.log1p(yield_24h) / log_max if log_max else 0.0

        # Event-yield component: how often an article becomes a real event.
        event_yield = events_24h / max(yield_24h, 1) if yield_24h else 0.0

        # Freshness: hours since last success, capped.
        if isinstance(last_success, datetime):
            age_h = max(0.0, (datetime.now(timezone.utc) - last_success).total_seconds() / 3600)
        else:
            # No successful fetch yet → treat as 30 days stale but
            # don't kill cold-start sources entirely.
            age_h = 24 * 30
        freshness = max(0.0, 1.0 - age_h / (24 * 7))  # decay over a week

        # Error rate penalty (Bayesian-ish: shrink toward 0 with few obs).
        total_obs = yield_7d + errors + 1
        error_rate = errors / total_obs

        # Exploration bonus for cold-start: source has never been seen
        # to succeed but isn't erroring either. Boost so they get tried.
        is_cold = (yield_24h == 0 and yield_7d == 0 and errors == 0)
        exploration = 0.20 if is_cold else 0.0

        # Composite.
        score = (
            0.40 * yield_score
            + 0.25 * event_yield
            + 0.20 * freshness
            + 0.10 * (1.0 - error_rate)
            + 0.05 * prev_reliability  # gentle inertia
            + exploration
        )
        # Floor at 0, ceiling at 1.
        score = max(0.0, min(1.0, score))

        # Tier.
        tier, interval, cap = _tier_for(
            score, error_count=errors, active=active,
        )

        # Decision label relative to where they were.
        if tier == "paused":
            decision = "deprioritize"
        elif interval < prev_interval:
            decision = "promote"
        elif interval > prev_interval:
            decision = "demote"
        else:
            decision = "hold"

        # Reasons — for the audit log.
        reasons: list[str] = []
        if yield_24h == 0 and yield_7d == 0:
            reasons.append("no_recent_yield")
        if errors >= 5:
            reasons.append(f"high_error_count={errors}")
        if is_cold:
            reasons.append("cold_start_exploration")
        if event_yield > 0.6 and yield_24h > 5:
            reasons.append(f"high_event_yield={event_yield:.2f}")
        if freshness > 0.9:
            reasons.append("fresh")
        if freshness < 0.3:
            reasons.append("stale")
        if not reasons:
            reasons.append(f"composite={score:.2f}")

        scored.append({
            "id": r["id"],
            "name": r["name"],
            "country": r["country"],
            "score": score,
            "tier": tier,
            "interval": interval,
            "cap": cap,
            "decision": decision,
            "reliability": score,  # write score back as reliability_score
            "yield_24h": yield_24h,
            "events_24h": events_24h,
            "error_count": errors,
            "reasons": reasons,
            "prev_reliability": prev_reliability,
            "prev_interval": prev_interval,
        })

    # Apply updates + audit log in a single transaction.
    summary = {"sources": len(scored), "tiers": {}, "promoted": 0, "demoted": 0}
    with connect() as conn, conn.cursor() as cur:
        for s in scored:
            cur.execute("""
                UPDATE news_sources
                   SET reliability_score = %s,
                       poll_interval_s   = %s
                 WHERE id = %s
            """, (s["reliability"], s["interval"], s["id"]))

            cur.execute("""
                INSERT INTO news_fetch_decisions
                    (cycle_id, source_id, source_name, country, decision,
                     tier, score, poll_interval_s, reliability,
                     yield_24h, yield_events_24h, error_count, reasons)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """, (
                cycle_id, s["id"], s["name"], s["country"], s["decision"],
                s["tier"], s["score"], s["interval"], s["reliability"],
                s["yield_24h"], s["events_24h"], s["error_count"],
                json.dumps(s["reasons"]),
            ))

            summary["tiers"][s["tier"]] = summary["tiers"].get(s["tier"], 0) + 1
            if s["decision"] == "promote":
                summary["promoted"] += 1
            elif s["decision"] == "demote":
                summary["demoted"] += 1
        conn.commit()

    log.info(
        "priorities: scored=%d tiers=%s promoted=%d demoted=%d",
        summary["sources"], summary["tiers"], summary["promoted"], summary["demoted"],
    )
    return summary


# ── 2. Coverage-gap detector ─────────────────────────────────────────
def detect_coverage_gaps(cycle_id: str, *, apply_boost: bool = True) -> dict:
    """Score every country by events_per_million; bump sources from
    high-gap countries; write to news_coverage_gaps."""
    with connect() as conn, conn.cursor() as cur:
        # Country-level yield over the last 24h. Both sides get normalized
        # via normalize_country() in Python so "United States" / "US" /
        # "United Kingdom" / "GB" / "中国" all collapse to the same row.
        cur.execute("""
            SELECT
                COALESCE(l.country, '?') AS country,
                COUNT(DISTINCT e.id) AS events_24h
            FROM news_events e
            LEFT JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.first_reported_at > now() - interval '24 hours'
            GROUP BY 1
        """)
        event_rows = cur.fetchall()

        cur.execute("""
            WITH src AS (
                SELECT country, COUNT(*) AS source_count,
                       COUNT(*) FILTER (WHERE active) AS active_sources
                FROM news_sources GROUP BY country
            ),
            art AS (
                SELECT s.country, COUNT(a.id) AS articles_24h
                FROM news_sources s
                JOIN news_articles a ON a.source_id = s.id
                WHERE a.fetched_at > now() - interval '24 hours'
                GROUP BY s.country
            )
            SELECT
                COALESCE(src.country, '?') AS country,
                COALESCE(src.source_count, 0) AS source_count,
                COALESCE(src.active_sources, 0) AS active_sources,
                COALESCE(art.articles_24h, 0) AS articles_24h
            FROM src LEFT JOIN art ON art.country = src.country
        """)
        source_rows = cur.fetchall()

    # Normalize and merge.
    merged: dict[str, dict] = {}
    for r in event_rows:
        cc_norm = normalize_country(r["country"]) or (r["country"] if r["country"] != "?" else None)
        if not cc_norm:
            continue
        merged.setdefault(cc_norm.upper(), {
            "country": cc_norm.upper(),
            "events_24h": 0, "source_count": 0,
            "active_sources": 0, "articles_24h": 0,
        })
        merged[cc_norm.upper()]["events_24h"] = int(r["events_24h"] or 0)

    for r in source_rows:
        cc_norm = normalize_country(r["country"]) or (r["country"] if r["country"] != "?" else None)
        if not cc_norm:
            continue
        merged.setdefault(cc_norm.upper(), {
            "country": cc_norm.upper(),
            "events_24h": 0, "source_count": 0,
            "active_sources": 0, "articles_24h": 0,
        })
        merged[cc_norm.upper()]["source_count"] = int(r["source_count"] or 0)
        merged[cc_norm.upper()]["active_sources"] = int(r["active_sources"] or 0)
        merged[cc_norm.upper()]["articles_24h"] = int(r["articles_24h"] or 0)

    rows = [{"country": v["country"],
             "events_24h": v["events_24h"],
             "source_count": v["source_count"],
             "active_sources": v["active_sources"],
             "articles_24h": v["articles_24h"]} for v in merged.values()]

    gap_records: list[dict] = []
    for r in rows:
        cc = (r["country"] or "").strip()
        cc_norm = normalize_country(cc) or (cc if cc else None)
        if not cc_norm or cc_norm == "?":
            continue
        ref = COUNTRY_POPULATION.get(cc_norm.upper())
        if not ref:
            # Unknown ISO code — still log it but with pop=0 (no gap math).
            pop = 0
            name = cc
            region = "unknown"
        else:
            pop = ref["pop"]
            name = ref["name"]
            region = ref["region"]

        events_24h = int(r["events_24h"] or 0)
        articles_24h = int(r["articles_24h"] or 0)
        active_sources = int(r["active_sources"] or 0)
        source_count = int(r["source_count"] or 0)

        events_per_m = events_24h / pop if pop else 0
        # Gap score: higher = more underrepresented.
        # log10(population) - log10(events_per_million + 0.1)
        if pop > 0:
            gap = math.log10(pop + 1) - math.log10(events_per_m + 0.01)
        else:
            gap = 0.0
        # Penalize zero sources harder than just low yield.
        if active_sources == 0:
            gap += 1.5
        elif active_sources < 2 and pop > 50:
            gap += 0.5

        # Priority boost multiplier — capped at 2x, scaled to gap range.
        boost = max(0.5, min(2.0, 1.0 + gap * 0.2))

        notes = None
        if active_sources == 0 and pop > 20:
            notes = "no_active_sources_for_popular_country"
        elif events_per_m < 0.01 and pop > 100:
            notes = "low_yield_for_population"
        elif events_per_m > 1.0:
            notes = "well_covered"

        gap_records.append({
            "country_code": cc_norm.upper(),
            "country_name": name,
            "population": pop,
            "source_count": source_count,
            "active_sources": active_sources,
            "articles_24h": articles_24h,
            "events_24h": events_24h,
            "events_per_million_24h": events_per_m,
            "gap_score": round(gap, 3),
            "priority_boost": round(boost, 3),
            "notes": notes,
        })

    # Sort so largest gaps surface first.
    gap_records.sort(key=lambda x: x["gap_score"], reverse=True)

    # Persist.
    with connect() as conn, conn.cursor() as cur:
        for g in gap_records:
            cur.execute("""
                INSERT INTO news_coverage_gaps
                    (cycle_id, country_code, country_name, population,
                     source_count, active_sources, articles_24h, events_24h,
                     events_per_million_24h, gap_score, priority_boost, notes)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (cycle_id, country_code) DO UPDATE SET
                    country_name = EXCLUDED.country_name,
                    population = EXCLUDED.population,
                    source_count = EXCLUDED.source_count,
                    active_sources = EXCLUDED.active_sources,
                    articles_24h = EXCLUDED.articles_24h,
                    events_24h = EXCLUDED.events_24h,
                    events_per_million_24h = EXCLUDED.events_per_million_24h,
                    gap_score = EXCLUDED.gap_score,
                    priority_boost = EXCLUDED.priority_boost,
                    notes = EXCLUDED.notes
            """, (
                cycle_id, g["country_code"], g["country_name"], g["population"],
                g["source_count"], g["active_sources"], g["articles_24h"], g["events_24h"],
                g["events_per_million_24h"], g["gap_score"], g["priority_boost"], g["notes"],
            ))
        conn.commit()

    # Apply boost: multiply poll_interval_s of sources from high-gap
    # countries by 1/boost (so they get fetched more often). Soft cap so
    # we don't hammer tiny countries forever.
    boost_summary = {"applied": 0, "country": ""}
    if apply_boost and gap_records:
        # Take top 3 underrepresented countries with >10M population.
        top_gaps = [g for g in gap_records if g["population"] >= 10][:3]
        for g in top_gaps:
            target_cc = g["country_code"]
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_sources
                       SET poll_interval_s = GREATEST(300, (poll_interval_s * 0.6)::int)
                     WHERE country = %s AND active = TRUE
                """, (target_cc,))
                applied = cur.rowcount
                conn.commit()
                boost_summary["applied"] += applied
                boost_summary["country"] = target_cc

    summary = {
        "countries_scored": len(gap_records),
        "top_gaps": gap_records[:5],
        "boost_applied": boost_summary,
    }
    log.info(
        "gaps: scored=%d top=%s boost=%s",
        summary["countries_scored"],
        [(g["country_code"], round(g["gap_score"], 2)) for g in gap_records[:5]],
        boost_summary,
    )
    return summary


# ── 3. Extraction-quality feedback ──────────────────────────────────
def feedback_extraction(cycle_id: str, *, sample: int = 200) -> dict:
    """Sample the most recent articles and log per-article extraction
    outcomes so future prompt tuning has labeled signal."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                a.id, a.source_id, a.title, a.event_type,
                a.location_text, a.extracted_lat, a.extracted_lng,
                a.status, a.location_confidence,
                l.lat, l.lng,
                l.place_name, l.country AS extracted_country,
                l.precision AS geocode_precision,
                EXISTS(SELECT 1 FROM news_event_sources es WHERE es.article_id = a.id
                        AND es.created_at > a.fetched_at) AS had_source_event
            FROM news_articles a
            LEFT JOIN news_locations l ON l.id = a.location_id
            WHERE a.fetched_at > now() - interval '7 days'
              AND a.status IN ('extracted', 'unlocated', 'clustered')
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (sample,))
        articles = cur.fetchall()

    feedback_rows: list[dict] = []
    issue_counts: dict[str, int] = {}

    for a in articles:
        issues: list[str] = []
        # Geocoded = either we resolved via locations table OR the
        # extractor returned usable lat/lng directly.
        geocoded = (
            (a["lat"] is not None and a["lng"] is not None)
            or (a["extracted_lat"] is not None and a["extracted_lng"] is not None)
        )

        if not geocoded:
            issues.append("not_geocoded")
        if not a["location_text"]:
            issues.append("no_place_text")
        if a["extracted_country"]:
            normalized = normalize_country(a["extracted_country"])
            if normalized is None:
                issues.append("country_unrecognized")
                issues.append(f"country_raw={a['extracted_country'][:40]}")
            elif normalized != a["extracted_country"].upper() and \
                 a["extracted_country"].upper() != normalized:
                issues.append("country_needs_normalize")
        else:
            issues.append("country_missing")

        # Clustered? We approximate by checking if this article landed
        # in news_event_sources after it was fetched.
        cluster_merged = bool(a["had_source_event"])

        for issue in issues:
            issue_counts[issue] = issue_counts.get(issue, 0) + 1

        feedback_rows.append({
            "article_id": a["id"],
            "source_id": a["source_id"],
            "title": (a["title"] or "")[:200],
            "extracted_country": a["extracted_country"],
            "normalized_country": normalize_country(a["extracted_country"]) if a["extracted_country"] else None,
            "extracted_place": a["location_text"],
            "geocoded": geocoded,
            "geocode_precision": a["geocode_precision"],
            "cluster_merged": cluster_merged,
            "issues": issues,
        })

    with connect() as conn, conn.cursor() as cur:
        for f in feedback_rows:
            cur.execute("""
                INSERT INTO news_extraction_feedback
                    (cycle_id, article_id, source_id, title,
                     extracted_country, normalized_country, extracted_place,
                     geocoded, geocode_precision, cluster_merged, issues)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            """, (
                cycle_id, f["article_id"], f["source_id"], f["title"],
                f["extracted_country"], f["normalized_country"], f["extracted_place"],
                f["geocoded"], f["geocode_precision"], f["cluster_merged"],
                json.dumps(f["issues"]),
            ))
        conn.commit()

    summary = {
        "sampled": len(feedback_rows),
        "geocoded": sum(1 for f in feedback_rows if f["geocoded"]),
        "issues": dict(sorted(issue_counts.items(), key=lambda kv: -kv[1])),
    }
    log.info(
        "extraction feedback: sampled=%d geocoded=%d issues=%s",
        summary["sampled"], summary["geocoded"], summary["issues"],
    )
    return summary


# ── 4. Source-city affinity + keyword profiler ──────────────────────
#
# Two sub-systems that run as part of the learn cycle:
#
#   a) update_source_affinity()
#      Scans recent articles per source, groups by city, applies
#      exponential decay (half-life ≈ 30 days), and writes the
#      weighted scores to news_source_city_affinity.  Also updates
#      news_sources.primary_city_id / confidence for fast lookup.
#
#   b) update_source_keywords()
#      Aggregates word_freq from recent articles per source, ranks
#      by TF-like score, and stores the top 50 keywords per source
#      in news_source_keywords.  Used for story linking.

DECAY_HALF_LIFE_DAYS = 30.0
DECAY_LAMBDA = math.log(2) / DECAY_HALF_LIFE_DAYS
AFFINITY_WINDOW_DAYS = 180
KEYWORD_TOP_N = 50
KEYWORD_WINDOW_DAYS = 90

# Words too generic to be useful as story-linking keywords.
_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "this", "that", "are", "was",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "not", "no",
    "new", "old", "big", "small", "good", "bad", "first", "last",
    "long", "great", "little", "own", "other", "right", "high",
    "different", "large", "next", "early", "young", "important",
    "few", "public", "same", "able", "said", "says", "also", "just",
    "one", "two", "three", "four", "five", "six", "seven", "eight",
    "ten", "hundred", "thousand", "million", "billion",
    "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "january", "february", "march",
    "april", "may", "june", "july", "august", "september",
    "october", "november", "december",
    "us", "uk", "eu", "un", "usa", "today", "yesterday", "tomorrow",
    "news", "report", "story", "article", "people", "person",
    "world", "country", "city", "state", "government", "official",
    "according", "after", "before", "between", "through", "during",
    "about", "over", "under", "again", "then", "than", "more",
    "some", "all", "any", "each", "every", "both", "many", "most",
    "such", "like", "make", "made", "get", "got", "take", "come",
    "go", "going", "know", "see", "think", "look", "want", "give",
    "use", "find", "tell", "ask", "work", "seem", "feel", "try",
    "leave", "call", "keep", "let", "begin", "show", "hear",
    "play", "run", "move", "live", "believe", "bring", "happen",
})


def update_source_affinity() -> dict:
    """Compute source-city affinity with exponential decay.

    For each active source with ≥10 articles in the window:
      1. Group articles by city (using auto_categorize_city_id or
         extracted_location → world_cities match).
      2. Apply exponential decay: weight = e^(-λ × days_ago).
      3. Write top cities to news_source_city_affinity.
      4. Update news_sources.primary_city_id + confidence.

    Returns summary dict.
    """
    now = datetime.now(timezone.utc)
    window_start = now - __import__("datetime").timedelta(days=AFFINITY_WINDOW_DAYS)

    with connect() as conn, conn.cursor() as cur:
        # Fetch recent articles with city info for all active sources
        cur.execute("""
            SELECT a.source_id, a.id as article_id, a.fetched_at,
                   a.auto_categorize_city_id, a.extracted_location,
                   a.extracted_lat, a.extracted_lng, s.country as source_country
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.status = 'extracted'
              AND a.fetched_at >= %s
              AND s.active = true
            ORDER BY a.source_id, a.fetched_at DESC
        """, (window_start,))
        articles = cur.fetchall()

    if not articles:
        return {"sources_processed": 0, "cities_tracked": 0}

    # Group by source
    by_source: dict[int, list[dict]] = {}
    for a in articles:
        by_source.setdefault(a["source_id"], []).append(a)

    summary = {"sources_processed": 0, "cities_tracked": 0, "profiles_updated": 0}

    with connect() as conn, conn.cursor() as cur:
        for source_id, source_articles in by_source.items():
            if len(source_articles) < 10:
                continue

            src_country = (source_articles[0].get("source_country") or "").strip().upper()

            # Group by city, compute decay-weighted score
            city_scores: dict[int, dict] = {}
            for art in source_articles:
                city_id = art.get("auto_categorize_city_id")
                if not city_id:
                    continue

                fetched = art["fetched_at"]
                if isinstance(fetched, datetime):
                    days_ago = max(0, (now - fetched).total_seconds() / 86400)
                else:
                    days_ago = 0
                weight = math.exp(-DECAY_LAMBDA * days_ago)

                if city_id not in city_scores:
                    city_scores[city_id] = {
                        "count": 0, "score": 0.0, "last": fetched,
                    }
                city_scores[city_id]["count"] += 1
                city_scores[city_id]["score"] += weight
                if not city_scores[city_id]["last"] or (
                    isinstance(fetched, datetime) and
                    (not isinstance(city_scores[city_id]["last"], datetime) or
                     fetched > city_scores[city_id]["last"])
                ):
                    city_scores[city_id]["last"] = fetched

            if not city_scores:
                continue

            # Look up city details from world_cities
            city_ids = list(city_scores.keys())
            cur.execute("""
                SELECT id, name, country_code, lat, lng
                FROM world_cities WHERE id = ANY(%s)
            """, (city_ids,))
            city_info = {r["id"]: r for r in cur.fetchall()}

            # Normalize scores to 0-1 range
            max_score = max(cs["score"] for cs in city_scores.values()) or 1.0

            # Clear old affinity for this source, write fresh
            cur.execute("DELETE FROM news_source_city_affinity WHERE source_id = %s",
                        (source_id,))

            for city_id, cs in city_scores.items():
                info = city_info.get(city_id)
                if not info:
                    continue
                norm_score = cs["score"] / max_score
                cur.execute("""
                    INSERT INTO news_source_city_affinity
                        (source_id, city_id, city_name, country_code, lat, lng,
                         article_count, weighted_score, last_article_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    source_id, city_id, info["name"], info["country_code"],
                    info["lat"], info["lng"],
                    cs["count"], norm_score, cs["last"],
                ))
                summary["cities_tracked"] += 1

            # Update source profile: filter by source country matching if set
            sorted_cities = sorted(city_scores.items(),
                                  key=lambda x: x[1]["score"], reverse=True)
            valid_cities = [
                cid for cid, _ in sorted_cities
                if not src_country or not city_info.get(cid) or (city_info[cid].get("country_code") or "").upper() == src_country
            ]
            top_city_id = valid_cities[0] if valid_cities else None
            secondary_city_id = valid_cities[1] if len(valid_cities) > 1 else None

            if top_city_id:
                top_score = city_scores[top_city_id]["score"]
                total_score = sum(cs["score"] for cs in city_scores.values())
                confidence = top_score / total_score if total_score > 0 else 0.0

                cur.execute("""
                    UPDATE news_sources
                    SET primary_city_id = %s,
                        primary_city_confidence = %s,
                        secondary_city_id = %s,
                        location_profile_updated_at = now()
                    WHERE id = %s
                """, (top_city_id, confidence, secondary_city_id, source_id))
                summary["profiles_updated"] += 1
                summary["sources_processed"] += 1

        conn.commit()

    log.info("affinity: sources=%d cities=%d profiles=%d",
             summary["sources_processed"], summary["cities_tracked"],
             summary["profiles_updated"])
    return summary


def update_source_keywords() -> dict:
    """Extract top 50 keywords per source from article word_freq.

    Aggregates word frequencies across recent articles, filters
    stopwords, and stores the ranked keywords in news_source_keywords.
    Used for story linking — articles from the same source sharing
    keywords are likely related.

    Returns summary dict.
    """
    window_start = datetime.now(timezone.utc) - __import__("datetime").timedelta(days=KEYWORD_WINDOW_DAYS)

    with connect() as conn, conn.cursor() as cur:
        # The pool default (statement_timeout=60000 in worker/db.py) is
        # too tight here: this scans ~3M extracted articles over the
        # 90-day window and measured 94s, so the whole nightly cycle died
        # with QueryCanceled at learn.py:1132 on 10-27..10-30 — which
        # silently skipped the steps BELOW it in run_all()
        # (location_rankings and the calculate_source_rankings /
        # calculate_geo_interest / source_leaderboard refresh). Raise it
        # for this session only and RESET before the pooled connection is
        # returned — the same pattern compute_tfidf.py already uses.
        conn.execute("SET statement_timeout = '600s'")
        try:
            cur.execute("""
                SELECT source_id, word_freq
                FROM news_articles
                WHERE status = 'extracted'
                  AND fetched_at >= %s
                  AND word_freq IS NOT NULL
                  AND word_freq != '{}'::jsonb
                  AND source_id IS NOT NULL
            """, (window_start,))
            rows = cur.fetchall()
        finally:
            conn.execute("RESET statement_timeout")

    if not rows:
        return {"sources_processed": 0, "keywords_stored": 0}

    # Aggregate per source
    by_source: dict[int, dict[str, dict]] = {}
    for row in rows:
        sid = row["source_id"]
        # news_source_keywords.source_id is NOT NULL, so a NULL here is a
        # hard NotNullViolation that kills the whole nightly cycle (seen
        # 10-31 from a 50-article batch inserted with no source row). The
        # query already filters it; this is the belt to that braces.
        if sid is None:
            continue
        wf = row.get("word_freq") or {}
        if not isinstance(wf, dict):
            continue
        if sid not in by_source:
            by_source[sid] = {}
        for word, count in wf.items():
            if not isinstance(count, (int, float)):
                continue
            word_lower = word.lower().strip()
            if len(word_lower) < 3:
                continue
            if word_lower in _STOPWORDS:
                continue
            if not word_lower[0].isalpha():
                continue
            if word_lower not in by_source[sid]:
                by_source[sid][word_lower] = {"freq": 0.0, "docs": 0}
            by_source[sid][word_lower]["freq"] += count
            by_source[sid][word_lower]["docs"] += 1

    summary = {"sources_processed": 0, "keywords_stored": 0}

    with connect() as conn, conn.cursor() as cur:
        for source_id, keywords in by_source.items():
            if not keywords:
                continue

            # Sort by frequency, take top N
            sorted_kw = sorted(keywords.items(), key=lambda x: x[1]["freq"], reverse=True)
            top_kw = sorted_kw[:KEYWORD_TOP_N]

            # Normalize: max freq = 1.0
            max_freq = top_kw[0][1]["freq"] if top_kw else 1.0

            # Clear old keywords, write fresh
            cur.execute("DELETE FROM news_source_keywords WHERE source_id = %s",
                        (source_id,))

            for rank, (word, data) in enumerate(top_kw, start=1):
                norm_freq = data["freq"] / max_freq if max_freq > 0 else 0
                cur.execute("""
                    INSERT INTO news_source_keywords
                        (source_id, keyword, frequency, doc_count, rank, updated_at)
                    VALUES (%s, %s, %s, %s, %s, now())
                """, (source_id, word, norm_freq, data["docs"], rank))
                summary["keywords_stored"] += 1

            # FIX (2026-09-26): commit per source. This used to hold ONE
            # transaction open across the whole rebuild (21+ min idle-in-
            # transaction observed) — blocking DDL and autovacuum on the
            # way, and rolling back 4,000 sources of work if one row failed.
            conn.commit()
            summary["sources_processed"] += 1

    log.info("keywords: sources=%d keywords=%d",
             summary["sources_processed"], summary["keywords_stored"])
    return summary


# ── Location Rankings from Zoom Tracking ─────────────────────────────────
def update_location_rankings() -> dict:
    """Aggregate zoom-level view signals into news_location_rankings.

    This is the core of the zoom tracking loop:
    - Zoom 1-7 (country/regional): broad interest signals
    - Zoom 8-9 (state/regional): targeted interest
    - Zoom 10+ (city-level): STRONG signal — user wants news about THIS city

    Higher zoom = more specific information need = higher discovery priority.
    """
    with connect() as conn, conn.cursor() as cur:
        # Aggregate zoom-weighted views per city
        cur.execute("""
            INSERT INTO news_location_views (
                session_id, view_type, center_lat, center_lng,
                zoom_level, bbox, duration_ms
            )
            -- This aggregates raw views into ranked locations
            -- zoom_level >= 10 is the "city-level" threshold
            -- Duration is weighted by zoom depth (longer time at high zoom = stronger intent)
            SELECT
                'aggregate'::text,
                'map_view'::text,
                ROUND(center_lat::numeric, 2)::float,
                ROUND(center_lng::numeric, 2)::float,
                zoom_level,
                bbox,
                AVG(duration_ms)::int
            FROM news_location_views
            WHERE created_at > now() - interval '7 days'
              AND view_type = 'map_view'
              AND zoom_level >= 1
            GROUP BY
                ROUND(center_lat::numeric, 2),
                ROUND(center_lng::numeric, 2),
                zoom_level,
                bbox
            ON CONFLICT DO NOTHING
        """)
        conn.commit()

    # Now call the SQL function that does the real aggregation
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT calculate_location_rankings()")
        conn.commit()

    log.info("location_rankings: updated zoom-level view aggregations")
    return {"status": "ok"}


# ── Orchestrator ─────────────────────────────────────────────────────
def run_all(cycle_id: str | None = None) -> dict:
    cycle_id = cycle_id or f"cycle_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}"
    log.info("learn cycle %s starting", cycle_id)
    out = {
        "cycle_id": cycle_id,
        "cadence": calculate_and_update_cadence(apply_recommendations=False),
        "priorities": update_priorities(cycle_id),
        "gaps": detect_coverage_gaps(cycle_id),
        "extraction": feedback_extraction(cycle_id),
        "affinity": update_source_affinity(),
        "keywords": update_source_keywords(),
        "location_rankings": update_location_rankings(),
    }
    # Roll the SQL aggregate functions that drive the analytics endpoints.
    # These repopulate news_source_rankings + news_geo_interest from
    # news_interactions, and refresh the source_leaderboard materialized
    # view that /api/analytics/rankings/sources queries.
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT calculate_source_rankings()")
            cur.execute("SELECT calculate_geo_interest(24)")
            cur.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY source_leaderboard")
            conn.commit()
        out["aggregates_refreshed"] = True
    except Exception as e:
        log.warning("aggregates refresh failed: %s", e)
        out["aggregates_refreshed"] = False
    return out


# ── CLI ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    p = argparse.ArgumentParser(description="Xyzo learning loop")
    p.add_argument("--only", choices=["priorities", "gaps", "extraction", "affinity", "keywords", "cadence", "location_rankings"],
                   help="Run only one sub-system")
    p.add_argument("--cycle-id", help="Override the auto-generated cycle id")
    p.add_argument("--sample", type=int, default=200,
                   help="Article sample size for extraction feedback")
    p.add_argument("--no-boost", action="store_true",
                   help="Don't apply country-level priority boosts")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    cycle_id = args.cycle_id or f"cycle_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}"

    if args.only == "cadence":
        out = {"cycle_id": cycle_id, "cadence": calculate_and_update_cadence(apply_recommendations=False)}
    elif args.only == "priorities":
        out = {"cycle_id": cycle_id, "priorities": update_priorities(cycle_id)}
    elif args.only == "gaps":
        out = {"cycle_id": cycle_id, "gaps": detect_coverage_gaps(cycle_id, apply_boost=not args.no_boost)}
    elif args.only == "extraction":
        out = {"cycle_id": cycle_id, "extraction": feedback_extraction(cycle_id, sample=args.sample)}
    elif args.only == "affinity":
        out = {"cycle_id": cycle_id, "affinity": update_source_affinity()}
    elif args.only == "keywords":
        out = {"cycle_id": cycle_id, "keywords": update_source_keywords()}
    elif args.only == "location_rankings":
        out = {"cycle_id": cycle_id, "location_rankings": update_location_rankings()}
    else:
        out = run_all(cycle_id)

    json.dump(out, sys.stdout, default=str)
    sys.stdout.write("\n")
