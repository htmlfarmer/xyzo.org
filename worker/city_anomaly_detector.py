"""Automated City Anomaly Detector for Xyzo.

Proactively monitors and detects mislocated story clusters across news_locations:
  1. Lexical Mention Absence: Stories pinned to City X that never mention City X.
  2. Homonym & False-Entity Rejection: Disambiguation checks for common nouns/verbs
     (Pueblo, Mesa, Fez, Libertad, Poblacion, Hub, Split, Same, Man, etc.) or
     platform entity HQs (YouTube -> San Bruno, PlayStation -> San Mateo, Netflix -> Los Gatos).
  3. Foreign Source Divergence: High concentration of foreign sources with no local country context.
  4. Language Divergence: High concentration of non-local language in monolingual cities.

Usage:
    python -m worker.city_anomaly_detector                 # scan report (dry-run)
    python -m worker.city_anomaly_detector --quarantine     # apply fixes: unlocate bogus articles & cleanup events
    python -m worker.city_anomaly_detector --min-articles 3 # evaluate clusters with >= 3 articles
    python -m worker.city_anomaly_detector --json           # output machine-readable JSON
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import connect
from .place_disambiguation import disambiguate, watchlisted_names

log = logging.getLogger("xyzo.city_anomaly_detector")

# Dominant country language expectations
COUNTRY_LANGUAGES = {
    "US": {"en"}, "GB": {"en"}, "AU": {"en"}, "CA": {"en", "fr"}, "NZ": {"en"},
    "ES": {"es", "ca", "gl", "eu"}, "MX": {"es"}, "AR": {"es"}, "CO": {"es"},
    "CL": {"es"}, "PE": {"es"}, "VE": {"es"}, "EC": {"es"}, "GT": {"es"},
    "CU": {"es"}, "BO": {"es"}, "DO": {"es"}, "HN": {"es"}, "PY": {"es"},
    "SV": {"es"}, "NI": {"es"}, "CR": {"es"}, "PA": {"es"}, "UY": {"es"},
    "BR": {"pt"}, "PT": {"pt"},
    "FR": {"fr"}, "DE": {"de"}, "AT": {"de"}, "IT": {"it"}, "NL": {"nl"},
    "RU": {"ru"}, "UA": {"uk", "ru"}, "PL": {"pl"},
    "MA": {"ar", "fr"}, "DZ": {"ar", "fr"}, "TN": {"ar", "fr"}, "EG": {"ar"},
    "SA": {"ar"}, "AE": {"ar", "en"},
    "PK": {"ur", "en"}, "IN": {"hi", "en"},
    "CN": {"zh"}, "JP": {"ja"}, "KR": {"ko"},
    "PH": {"en", "tl", "fil"},
}


@dataclass
class AnomalyReport:
    location_id: int
    place_name: str
    country: str | None
    lat: float | None
    lng: float | None
    total_articles: int
    bogus_articles: int
    valid_articles: int
    lexical_absence_ratio: float
    disambig_rejection_ratio: float
    foreign_source_ratio: float
    language_divergence_ratio: float
    anomaly_score: float
    severity: str  # "high", "medium", "low"
    reasons: list[str] = field(default_factory=list)
    top_sources: list[dict] = field(default_factory=list)
    bogus_article_ids: list[int] = field(default_factory=list)


def extract_country_code(place_name: str, explicit_country: str | None = None) -> str | None:
    """Extract 2-letter ISO country code from place_name or explicit_country."""
    if explicit_country and len(explicit_country) == 2:
        return explicit_country.upper()
    if "," in place_name:
        parts = [p.strip() for p in place_name.split(",")]
        suffix = parts[-1].upper()
        if len(suffix) == 2 and suffix.isalpha():
            return suffix
    return None


def extract_bare_city_name(place_name: str) -> str:
    """Extract bare city name e.g. 'San Bruno, US' -> 'San Bruno'."""
    if "," in place_name:
        return place_name.split(",")[0].strip()
    return place_name.strip()


def detect_simple_lang(text: str) -> str:
    """Fast rule-based language heuristic for dominant languages."""
    lower = text.lower()
    scores = {
        "es": len(re.findall(r"\b(?:el|los|las|del|por|para|con|este|esta|noticias|gobierno|pero|más|consolas|desde)\b", lower)),
        "fr": len(re.findall(r"\b(?:le|les|des|du|dans|pour|avec|est|sont|une|sur|qui|par)\b", lower)),
        "pt": len(re.findall(r"\b(?:não|você|mais|está|foi|são|uma|pelo|pela|dos|das|no|na|nos|nas|ganha|anunciou|para)\b", lower)),
        "de": len(re.findall(r"\b(?:der|die|das|und|in|den|von|zu|mit|ist|im|für|auf|nicht)\b", lower)),
        "sr": len(re.findall(r"[абвгдђежзијклљмнњопрстћуфхцчџш]|\b(?:nije|kako|vesti|srpski|godine|bilo|može|zbog)\b", lower)),
        "ar": len(re.findall(r"[\u0600-\u06FF]", lower)),
    }
    top_lang, top_score = max(scores.items(), key=lambda x: x[1])
    return top_lang if top_score > 0 else "en"


def scan_location(loc: dict, articles: list[dict]) -> AnomalyReport | None:
    """Analyze a single location's articles and return an AnomalyReport if anomalous."""
    if not articles:
        return None

    loc_id = loc["id"]
    place_name = loc["place_name"] or ""
    bare_name = extract_bare_city_name(place_name)
    country_code = extract_country_code(place_name, loc.get("country"))
    total = len(articles)

    city_pattern = re.compile(rf"\b{re.escape(bare_name)}\b", re.I)

    lexical_absent_count = 0
    disambig_reject_count = 0
    foreign_source_count = 0
    lang_divergent_count = 0

    bogus_ids = []
    rejection_reasons = {}
    source_counts: dict[str, int] = {}

    expected_langs = COUNTRY_LANGUAGES.get(country_code or "", set())

    for art in articles:
        title = art.get("title") or ""
        body = art.get("body") or ""
        full_text = f"{title}\n{body[:2000]}"
        art_id = art["id"]

        # FIX_NOTES 1.9: src_country was first assigned in section 3 below
        # but used in section 2 — UnboundLocalError on the first article of
        # the first location, so the documented anomaly quarantine never ran.
        src_country = (art.get("source_country") or "").upper()

        # 1. Lexical mention presence
        if not city_pattern.search(title) and not city_pattern.search(body[:1000]):
            lexical_absent_count += 1

        # 2. Place disambiguation check
        keep, reason = disambiguate(bare_name, full_text, source_country=src_country)
        if not keep:
            disambig_reject_count += 1
            bogus_ids.append(art_id)
            rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1

        # 3. Source country divergence (src_country set at loop top — FIX_NOTES 1.9)
        if src_country:
            source_counts[src_country] = source_counts.get(src_country, 0) + 1
            if country_code and src_country != country_code:
                # Check if country name is in text
                country_in_text = bool(re.search(rf"\b{re.escape(country_code)}\b", full_text, re.I))
                if not country_in_text:
                    foreign_source_count += 1

        # 4. Language divergence
        if expected_langs:
            lang = detect_simple_lang(full_text)
            if lang not in expected_langs:
                lang_divergent_count += 1

    lexical_absence_ratio = lexical_absent_count / total
    disambig_rejection_ratio = disambig_reject_count / total
    foreign_source_ratio = foreign_source_count / total if source_counts else 0.0
    lang_divergence_ratio = lang_divergent_count / total if expected_langs else 0.0

    # Composite Anomaly Score (0.0 to 1.0)
    # Disambiguation rejection is highest priority, followed by lexical absence and foreign source
    score = (
        (disambig_rejection_ratio * 0.45) +
        (lexical_absence_ratio * 0.25) +
        (foreign_source_ratio * 0.15) +
        (lang_divergence_ratio * 0.15)
    )

    # If it's a known homonym on the watchlist or entity platform and rejects > 50%, boost score
    if bare_name.lower() in watchlisted_names() and disambig_rejection_ratio > 0.5:
        score = min(1.0, score + 0.2)

    # Threshold for anomaly
    if score < 0.50 and disambig_rejection_ratio < 0.50:
        return None

    severity = "high" if score >= 0.75 else ("medium" if score >= 0.55 else "low")

    reasons_list = []
    if disambig_rejection_ratio >= 0.5:
        top_reasons = sorted(rejection_reasons.items(), key=lambda x: -x[1])[:2]
        reasons_list.append(f"Disambiguation rejected {disambig_reject_count}/{total} stories ({', '.join(f'{k}:{v}' for k, v in top_reasons)})")
    if lexical_absence_ratio >= 0.7:
        reasons_list.append(f"Bare city name '{bare_name}' absent in {lexical_absent_count}/{total} stories ({lexical_absence_ratio:.0%})")
    if foreign_source_ratio >= 0.6:
        reasons_list.append(f"Foreign source divergence in {foreign_source_count}/{total} stories ({foreign_source_ratio:.0%})")
    if lang_divergence_ratio >= 0.6:
        reasons_list.append(f"Language divergence ({lang_divergent_count}/{total} stories diverge from {','.join(expected_langs)})")

    top_sources = [
        {"country": cc, "count": cnt}
        for cc, cnt in sorted(source_counts.items(), key=lambda x: -x[1])[:3]
    ]

    return AnomalyReport(
        location_id=loc_id,
        place_name=place_name,
        country=country_code,
        lat=loc.get("lat"),
        lng=loc.get("lng"),
        total_articles=total,
        bogus_articles=disambig_reject_count,
        valid_articles=total - disambig_reject_count,
        lexical_absence_ratio=round(lexical_absence_ratio, 3),
        disambig_rejection_ratio=round(disambig_rejection_ratio, 3),
        foreign_source_ratio=round(foreign_source_ratio, 3),
        language_divergence_ratio=round(lang_divergence_ratio, 3),
        anomaly_score=round(score, 3),
        severity=severity,
        reasons=reasons_list,
        top_sources=top_sources,
        bogus_article_ids=bogus_ids,
    )


def scan_all_locations(min_articles: int = 3) -> list[AnomalyReport]:
    """Scan all active locations in the database for anomalies."""
    reports = []
    with connect() as conn, conn.cursor() as cur:
        # Fetch active locations with article counts >= min_articles
        cur.execute("""
            SELECT nl.id, nl.place_name, nl.country, nl.lat, nl.lng, count(a.id) as art_count
            FROM news_locations nl
            JOIN news_articles a ON a.location_id = nl.id
            GROUP BY nl.id, nl.place_name, nl.country, nl.lat, nl.lng
            HAVING count(a.id) >= %s
            ORDER BY art_count DESC;
        """, (min_articles,))
        locations = cur.fetchall()

        for loc in locations:
            cur.execute("""
                SELECT a.id, a.title, a.body, a.source_id, s.name as source_name, s.country as source_country
                FROM news_articles a
                LEFT JOIN news_sources s ON s.id = a.source_id
                WHERE a.location_id = %s;
            """, (loc["id"],))
            articles = cur.fetchall()

            report = scan_location(dict(loc), [dict(a) for a in articles])
            if report:
                reports.append(report)

    reports.sort(key=lambda r: (-r.anomaly_score, -r.total_articles))
    return reports


def apply_quarantine(reports: list[AnomalyReport], record_feedback: bool = True) -> dict[str, int]:
    """Unlocate bogus articles, record feedback for NN, and clean empty news_events."""
    all_bogus_ids: list[int] = []
    for r in reports:
        all_bogus_ids.extend(r.bogus_article_ids)

    if not all_bogus_ids:
        return {"unlocated_articles": 0, "cleaned_events": 0, "feedback_recorded": 0}

    unlocated_count = 0
    cleaned_events_count = 0
    feedback_count = 0

    with connect() as conn, conn.cursor() as cur:
        # 1. Unlocate articles in batches
        chunk_size = 500
        for i in range(0, len(all_bogus_ids), chunk_size):
            chunk = all_bogus_ids[i:i + chunk_size]
            cur.execute("""
                UPDATE news_articles
                SET location_id = NULL,
                    location_text = NULL,
                    extracted_location = NULL,
                    extracted_lat = NULL,
                    extracted_lng = NULL,
                    status = 'unlocated',
                    auto_categorize_city_id = NULL,
                    auto_categorize_city_label = NULL,
                    auto_categorize_status = 'no_match'
                WHERE id = ANY(%s);
            """, (chunk,))
            unlocated_count += cur.rowcount

            # Delete from news_article_cities
            cur.execute("""
                DELETE FROM news_article_cities
                WHERE article_id = ANY(%s);
            """, (chunk,))

        # 2. Record feedback in nn_user_corrections for NN learning loop
        if record_feedback:
            for rep in reports:
                for aid in rep.bogus_article_ids:
                    meta = json.dumps({
                        "city": rep.place_name,
                        "anomaly_score": rep.anomaly_score,
                        "reasons": rep.reasons,
                        "detector": "city_anomaly_detector",
                    })
                    cur.execute("""
                        INSERT INTO nn_user_corrections (
                            model_name, article_id, entity_type, entity_id,
                            original_lat, original_lng, original_country,
                            correction_type, metadata, used_in_training
                        ) VALUES (
                            'location_anomaly', %s, 'location', %s,
                            %s, %s, %s,
                            'location_reject', %s::jsonb, false
                        ) ON CONFLICT DO NOTHING;
                    """, (
                        aid, rep.location_id, rep.lat, rep.lng, rep.country, meta
                    ))
                    feedback_count += cur.rowcount

        # 3. Clean up empty news_events
        # Any event whose articles were all unlocated (no active links in news_event_sources)
        cur.execute("""
            DELETE FROM news_events ne
            WHERE NOT EXISTS (
                SELECT 1
                FROM news_event_sources nes
                JOIN news_articles a ON a.id = nes.article_id
                WHERE nes.event_id = ne.id
                  AND a.location_id IS NOT NULL
            );
        """)
        cleaned_events_count = cur.rowcount

        # Recompute source_count for remaining surviving events
        cur.execute("""
            UPDATE news_events ne
            SET source_count = (
                SELECT count(*)
                FROM news_event_sources nes
                JOIN news_articles a ON a.id = nes.article_id
                WHERE nes.event_id = ne.id
                  AND a.location_id IS NOT NULL
            )
            WHERE EXISTS (
                SELECT 1
                FROM news_event_sources nes
                JOIN news_articles a ON a.id = nes.article_id
                WHERE nes.event_id = ne.id
                  AND a.location_id IS NOT NULL
            );
        """)

        conn.commit()

    return {
        "unlocated_articles": unlocated_count,
        "cleaned_events": cleaned_events_count,
        "feedback_recorded": feedback_count,
    }


def main():
    parser = argparse.ArgumentParser(description="Automated City Anomaly Detector for Xyzo")
    parser.add_argument("--min-articles", type=int, default=3, help="Minimum articles to evaluate a location")
    parser.add_argument("--quarantine", "--fix", dest="fix", action="store_true", help="Apply fixes: unlocate bogus articles and clean events")
    parser.add_argument("--json", action="store_true", help="Output results in JSON format")
    parser.add_argument("--no-feedback", action="store_true", help="Do not write feedback to nn_user_corrections")

    args = parser.parse_args()

    reports = scan_all_locations(min_articles=args.min_articles)

    if args.json:
        out = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "anomalies_found": len(reports),
            "reports": [asdict(r) for r in reports],
        }
        print(json.dumps(out, indent=2))
        return

    print("=" * 80)
    print(f"  XYZO CITY ANOMALY DETECTOR REPORT  ({len(reports)} anomalous clusters found)")
    print("=" * 80)

    if not reports:
        print("✓ No anomalous city clusters detected.")
        return

    for r in reports:
        print(f"\n📍 [{r.severity.upper()}] {r.place_name} (ID {r.location_id}) — Score: {r.anomaly_score:.2f}")
        print(f"   Articles: {r.total_articles} total | {r.bogus_articles} bogus ({r.disambig_rejection_ratio:.0%}) | {r.valid_articles} valid")
        print(f"   Lexical absence: {r.lexical_absence_ratio:.0%} | Foreign sources: {r.foreign_source_ratio:.0%} | Lang divergence: {r.language_divergence_ratio:.0%}")
        if r.top_sources:
            src_str = ", ".join(f"{s['country']}:{s['count']}" for s in r.top_sources)
            print(f"   Top sources: {src_str}")
        for reason in r.reasons:
            print(f"   ⚠️  {reason}")

    print("\n" + "-" * 80)
    total_bogus = sum(r.bogus_articles for r in reports)
    print(f"Summary: {len(reports)} locations flagged, {total_bogus} bogus articles identified.")

    if args.fix:
        print("\nApplying quarantine and fixes...")
        res = apply_quarantine(reports, record_feedback=not args.no_feedback)
        print(f"✓ Unlocated {res['unlocated_articles']} bogus articles.")
        print(f"✓ Cleaned {res['cleaned_events']} empty news events.")
        print(f"✓ Recorded {res['feedback_recorded']} feedback corrections for NN training.")
    else:
        print("\n(Run with --quarantine or --fix to unlocate bogus articles and clean up map events.)")


if __name__ == "__main__":
    main()
