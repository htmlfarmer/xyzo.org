"""Coverage Bot — autonomously fills news coverage gaps worldwide.

Reads news_coverage_gaps, prioritizes by population × gap_score,
and runs source discovery for the worst-served countries. No user
interaction required — runs on a cron or as part of the pipeline.

Usage:
    python -m worker.coverage_bot              # discover for top 5 gaps
    python -m worker.coverage_bot --limit 10   # top 10 gaps
    python -m worker.coverage_bot --dry-run    # show what would be done
"""
from __future__ import annotations

import argparse
import logging
import time
from datetime import datetime, timezone

from .db import connect
from .immediate_discover import discover_and_fetch

log = logging.getLogger("xyzo.coverage_bot")

# Country center coordinates for discovery.
# Covers the top ~100 under-served countries by population.
COUNTRY_CENTERS: dict[str, tuple[float, float]] = {
    # Africa - Central
    "CD": (-4.0, 21.8),    # DR Congo
    "AO": (-12.3, 17.9),   # Angola
    "CG": (-4.0, 15.3),    # Republic of Congo
    "GA": (-0.8, 11.6),    # Gabon
    "GQ": (1.5, 10.0),     # Equatorial Guinea
    "CF": (6.6, 20.0),     # Central African Republic
    "CM": (7.4, 12.4),     # Cameroon
    # Africa - East
    "TZ": (-6.4, 34.9),    # Tanzania
    "KE": (-0.02, 37.9),   # Kenya
    "UG": (1.4, 32.3),     # Uganda
    "RW": (-1.9, 29.9),    # Rwanda
    "BI": (-3.4, 29.9),    # Burundi
    "ET": (9.1, 40.5),     # Ethiopia
    "ER": (15.2, 38.9),    # Eritrea
    "DJ": (11.8, 42.6),    # Djibouti
    "SO": (5.2, 46.2),     # Somalia
    "SS": (6.9, 31.3),     # South Sudan
    "MZ": (-18.7, 35.5),   # Mozambique
    "MW": (-13.5, 34.0),   # Malawi
    "MG": (-18.8, 46.9),   # Madagascar
    "MU": (-20.2, 57.6),   # Mauritius
    "SC": (-4.6, 55.5),    # Seychelles
    "KM": (-11.6, 43.3),   # Comoros
    # Africa - North
    "SD": (15.6, 32.5),    # Sudan
    "LY": (26.3, 17.0),    # Libya
    "TN": (33.9, 9.5),     # Tunisia
    "DZ": (28.0, 1.7),     # Algeria
    "MA": (31.8, -7.1),    # Morocco
    "MR": (18.7, -10.1),   # Mauritania
    # Africa - Southern
    "ZA": (-30.6, 22.9),   # South Africa
    "BW": (-22.3, 24.7),   # Botswana
    "NA": (-22.0, 17.1),   # Namibia
    "ZW": (-19.0, 29.2),   # Zimbabwe
    "ZM": (-15.4, 28.3),   # Zambia
    "LS": (-29.6, 28.2),   # Lesotho
    "SZ": (-26.5, 31.3),   # Eswatini
    # Africa - West
    "NG": (9.1, 8.7),      # Nigeria
    "GH": (7.9, -1.0),     # Ghana
    "CI": (7.5, -5.5),     # Côte d'Ivoire
    "SN": (14.5, -14.5),   # Senegal
    "ML": (17.6, -4.0),    # Mali
    "NE": (17.6, 8.1),     # Niger
    "BF": (12.2, -1.6),    # Burkina Faso
    "GM": (13.4, -15.3),   # Gambia
    "GN": (10.4, -10.9),   # Guinea
    "GW": (11.8, -13.6),   # Guinea-Bissau
    "SL": (8.4, -11.8),    # Sierra Leone
    "LR": (6.3, -9.4),     # Liberia
    "TG": (6.6, 0.8),      # Togo
    "BJ": (6.5, 2.6),      # Benin
    # South Asia
    "MM": (19.7, 96.2),    # Myanmar
    "NP": (28.4, 84.1),    # Nepal
    "AF": (33.9, 67.7),    # Afghanistan
    "BD": (23.7, 90.4),    # Bangladesh
    "LK": (7.9, 80.8),     # Sri Lanka
    "BT": (27.5, 90.5),    # Bhutan
    "MV": (3.2, 73.5),     # Maldives
    "PK": (30.4, 69.3),    # Pakistan
    "IN": (20.6, 79.0),    # India (large coverage but still gaps)
    # Southeast Asia
    "KH": (12.6, 105.0),   # Cambodia
    "LA": (18.2, 102.5),   # Laos
    "PH": (12.9, 121.8),   # Philippines
    "TH": (15.9, 100.9),   # Thailand
    "VN": (14.1, 108.3),   # Vietnam
    "MY": (4.2, 101.9),    # Malaysia
    "ID": (-2.5, 118.0),   # Indonesia
    "SG": (1.3, 103.8),    # Singapore
    "BN": (4.5, 114.7),    # Brunei
    "TL": (-8.8, 125.7),   # Timor-Leste
    # East Asia
    "MN": (46.9, 103.8),   # Mongolia
    "KP": (40.3, 127.5),   # North Korea
    "KR": (35.9, 127.8),   # South Korea
    "JP": (36.2, 138.2),   # Japan
    "CN": (35.9, 104.2),   # China
    "TW": (23.7, 121.0),   # Taiwan
    "HK": (22.3, 114.2),   # Hong Kong
    # Central Asia
    "KZ": (48.0, 66.0),    # Kazakhstan
    "UZ": (41.4, 64.6),    # Uzbekistan
    "TJ": (38.9, 71.3),    # Tajikistan
    "KG": (41.2, 74.8),    # Kyrgyzstan
    "TM": (40.0, 59.0),    # Turkmenistan
    # Caucasus
    "GE": (42.3, 43.4),    # Georgia
    "AM": (40.1, 45.0),    # Armenia
    "AZ": (40.1, 47.6),    # Azerbaijan
    # Middle East
    "IQ": (33.2, 43.7),    # Iraq
    "IR": (32.4, 53.7),    # Iran
    "SA": (23.9, 45.1),    # Saudi Arabia
    "YE": (15.6, 48.5),    # Yemen
    "SY": (35.0, 38.5),    # Syria
    "JO": (30.6, 36.2),    # Jordan
    "LB": (33.9, 35.9),    # Lebanon
    "IL": (31.0, 34.8),    # Israel
    "PS": (31.9, 35.2),    # Palestine
    "AE": (23.4, 53.8),    # UAE
    "QA": (25.3, 51.2),    # Qatar
    "KW": (29.3, 47.5),    # Kuwait
    "BH": (26.0, 50.5),    # Bahrain
    "OM": (21.0, 57.0),    # Oman
    # Europe
    "PL": (51.9, 19.1),    # Poland
    "UA": (48.4, 31.2),    # Ukraine
    "BY": (53.7, 28.0),    # Belarus
    "RO": (45.9, 25.0),    # Romania
    "HU": (47.2, 19.5),    # Hungary
    "CZ": (49.8, 15.5),    # Czech Republic
    "SK": (48.7, 19.7),    # Slovakia
    "RS": (44.0, 21.0),    # Serbia
    "BG": (42.7, 25.5),    # Bulgaria
    "GR": (39.1, 21.8),    # Greece
    # Oceania
    "PG": (-6.3, 143.9),   # Papua New Guinea
    "FJ": (-17.7, 178.0),  # Fiji
    "NZ": (-40.9, 174.9),  # New Zealand
    "WS": (-13.8, -172.1),  # Samoa
    "TO": (-21.2, -175.2), # Tonga
    "VU": (-15.4, 166.9),  # Vanuatu
    "SB": (-9.6, 160.2),   # Solomon Islands
    "KI": (1.9, -157.4),   # Kiribati
    "FM": (7.5, 150.0),    # Micronesia
    "PW": (7.5, 134.5),    # Palau
    "MH": (9.0, 168.0),    # Marshall Islands
    # Latin America & Caribbean
    "CO": (4.6, -74.1),    # Colombia
    "PE": (-9.2, -75.0),   # Peru
    "VE": (6.4, -66.6),    # Venezuela
    "EC": (-1.8, -78.2),   # Ecuador
    "BO": (-16.3, -63.6),  # Bolivia
    "PY": (-23.4, -58.4),  # Paraguay
    "UY": (-32.8, -56.0),  # Uruguay
    "GY": (5.0, -58.9),    # Guyana
    "SR": (4.0, -56.0),    # Suriname
    "GT": (15.8, -90.2),   # Guatemala
    "SV": (13.8, -88.9),   # El Salvador
    "HN": (15.2, -86.2),   # Honduras
    "NI": (12.9, -85.3),   # Nicaragua
    "CR": (9.7, -83.8),    # Costa Rica
    "PA": (8.5, -80.8),    # Panama
    "BZ": (17.2, -88.5),   # Belize
    "CU": (21.5, -77.8),   # Cuba
    "HT": (18.5, -72.3),   # Haiti
    "DO": (18.7, -70.2),   # Dominican Republic
    "JM": (18.1, -77.3),   # Jamaica
    "TT": (10.6, -61.2),   # Trinidad & Tobago
    "BB": (13.2, -59.6),   # Barbados
    "BS": (24.3, -76.0),   # Bahamas
    "LC": (13.9, -60.9),   # Saint Lucia
    "GD": (12.1, -61.6),   # Grenada
    "VC": (13.0, -61.2),   # Saint Vincent & Grenadines
    "AG": (17.1, -61.8),   # Antigua & Barbuda
    "DM": (15.4, -61.3),   # Dominica
    "KN": (17.3, -62.7),   # Saint Kitts & Nevis
    "MX": (23.5, -102.5),  # Mexico
    "BR": (-10.8, -51.0),  # Brazil
    "AR": (-38.4, -63.6),  # Argentina
    "CL": (-35.7, -71.5),  # Chile
}


def get_priority_gaps(limit: int = 5) -> list[dict]:
    """Get the highest-priority coverage gaps.

    Prioritizes by: population × gap_score, filtered to countries
    with few sources and high population.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ON (country_code)
                   country_code, country_name, population,
                   source_count, active_sources, articles_24h,
                   events_24h, gap_score, status
            FROM news_coverage_gaps
            WHERE status = 'open'
              AND country_code != '?'
              AND (source_count < 5 OR articles_24h < 10)
            ORDER BY country_code, created_at DESC
        """)
        rows = cur.fetchall()

    # Filter to countries we have coordinates for, sort by priority
    result = []
    for r in rows:
        cc = r["country_code"]
        if cc in COUNTRY_CENTERS:
            r["center_lat"], r["center_lng"] = COUNTRY_CENTERS[cc]
            r["priority"] = (r["population"] or 1) * r["gap_score"]
            result.append(r)

    # Sort by priority (population × gap_score) descending
    result.sort(key=lambda x: x["priority"], reverse=True)
    return result[:limit]


def run(limit: int = 5, dry_run: bool = False) -> dict:
    """Run the coverage bot.

    Args:
        limit: Max countries to discover sources for.
        dry_run: If True, just log what would be done.

    Returns:
        Summary dict with per-country results.
    """
    log.info("coverage_bot: starting (limit=%d, dry_run=%s)", limit, dry_run)
    gaps = get_priority_gaps(limit)

    if not gaps:
        log.info("coverage_bot: no priority gaps found")
        return {"countries_processed": 0, "results": []}

    log.info("coverage_bot: top %d priority gaps:", len(gaps))
    for g in gaps:
        log.info("  %s (%s) pop=%s sources=%d gap=%.2f",
                 g["country_name"], g["country_code"],
                 f"{g['population']:,}" if g["population"] else "?",
                 g["source_count"], g["gap_score"])

    if dry_run:
        return {"countries_processed": len(gaps), "results": [],
                "dry_run": True, "gaps": gaps}

    results = []
    for g in gaps:
        cc = g["country_code"]
        lat, lng = g["center_lat"], g["center_lng"]
        log.info("coverage_bot: discovering sources for %s (%s) at %.2f,%.2f",
                 g["country_name"], cc, lat, lng)

        t0 = time.time()
        try:
            result = discover_and_fetch(
                lat=lat, lng=lng,
                country=cc,
                bbox=[lng - 3, lat - 2, lng + 3, lat + 2],
            )
            elapsed = time.time() - t0
            log.info("coverage_bot: %s → %d sources found, %d added, %d articles in %.1fs",
                     cc, result.get("sources_found", 0),
                     result.get("sources_added", 0),
                     result.get("articles_fetched", 0), elapsed)

            # Mark gap as being worked on
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_coverage_gaps
                    SET status = 'discovering',
                        notes = COALESCE(notes, '') || ' ' ||
                            to_char(now(), 'YYYY-MM-DD HH24:MI') ||
                            ': bot discovered %s sources, %s articles'
                    WHERE country_code = %s AND status = 'open'
                """, (str(result.get("sources_found", 0)),
                      str(result.get("articles_fetched", 0)),
                      cc))

            results.append({
                "country": cc,
                "country_name": g["country_name"],
                "sources_found": result.get("sources_found", 0),
                "sources_added": result.get("sources_added", 0),
                "articles_fetched": result.get("articles_fetched", 0),
                "elapsed_s": round(elapsed, 1),
            })
        except Exception as e:
            log.error("coverage_bot: %s failed: %s", cc, e)
            results.append({
                "country": cc,
                "country_name": g["country_name"],
                "error": str(e),
            })

        # Rate limit: wait between countries to avoid hammering
        time.sleep(2)

    summary = {
        "countries_processed": len(results),
        "total_sources_found": sum(r.get("sources_found", 0) for r in results),
        "total_sources_added": sum(r.get("sources_added", 0) for r in results),
        "total_articles_fetched": sum(r.get("articles_fetched", 0) for r in results),
        "results": results,
    }
    log.info("coverage_bot: done — %s", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description="Xyzo Coverage Bot")
    parser.add_argument("--limit", type=int, default=5,
                        help="Max countries to discover (default 5)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be done without doing it")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    result = run(limit=args.limit, dry_run=args.dry_run)
    import json
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
