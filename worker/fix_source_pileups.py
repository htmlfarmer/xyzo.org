#!/usr/bin/env python3
"""Repair "one source owns one capital" placement pileups.

THE BUG
-------
`auto_categorize._source_fallback()` used to place every article the fast
path could not locate onto a single city of the source's country. That is
only defensible when the source really publishes from that country. When
it does not, the source's ENTIRE output collapses onto one point and the
map lies:

  * "DEV Community" (dev.to — a global programming blog) was seeded with
    country=ML, so 12,368 of its articles sat on Bamako, Mali. The map
    showed "103 Stories in Bamako, ML" for the default 24 h window.
  * 141 pan-Arab sources were tagged country="ME" ("Middle East"), but ME
    is ISO **Montenegro** — 41,106 articles piled onto Podgorica.
  * "ReliefWeb" (UN, a global source) landed on New York (UN HQ).

The fix has two halves (see also `_source_geo_is_country_specific()` in
worker/auto_categorize.py):

  1. metadata  — a source's country must be a real country it publishes
     from ("ME"/"UN"/"EU" are not countries; dev.to is not Malian);
  2. cleanup   — the pileups that the old metadata produced have to be
     un-located and re-categorised from their own text.

USAGE
-----
    python -m worker.fix_source_pileups --dry-run          # report only
    python -m worker.fix_source_pileups --fix-sources      # country metadata
    python -m worker.fix_source_pileups --apply            # reset the piles
    python -m worker.fix_source_pileups --apply --limit 5  # small batch first
"""

import argparse
import logging
import os
import sys
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# No credentials in the repo: export XYZO_DB_DSN (or set PGPASSWORD)
# before running. The default matches worker/tests/conftest.py.
os.environ.setdefault("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")

from worker.db import connect

log = logging.getLogger("xyzo.fix_source_pileups")

# The shared connection pool sets statement_timeout=60s. The audit and
# the reset touch 1.6M rows and need longer.
POOL_STATEMENT_TIMEOUT_S = 60000


@contextmanager
def long_connection():
    """A pooled connection with the statement timeout lifted."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = 0")
        try:
            yield conn
        finally:
            try:
                with conn.cursor() as cur:
                    cur.execute(f"SET statement_timeout = {POOL_STATEMENT_TIMEOUT_S}")
            except Exception:
                pass

# A source needs at least this many source-based placements before we
# look at its geography at all.
MIN_PILEUP = 200
# Reporting threshold: how much of a source's own content lands in its
# configured country. Only used for the report — credibility is decided
# by the provable rules below.
MIN_COUNTRY_SHARE = 0.10

# Pseudo country codes: organisations / regions, never a place to pin to.
PSEUDO_COUNTRIES = {"UN", "EU", "GLOBAL", "WW", "ZZ"}
MENA_REGIONS = {"mena", "middle east", "middle-east", "mideast", "north africa"}


def fix_source_countries(apply: bool = False) -> dict:
    """Repair country metadata that can only produce wrong pins.

    * region=MENA + country='ME'  → 'ME' is Montenegro, not the Middle East
    * dev.to ('DEV Community')    → a global platform, not Malian
    * a source whose own-text articles are ~all in ONE other country
      (e.g. "Mali Actu" tagged AF) → its tag is simply wrong
    """
    summary = {"mena": 0, "dev_to": 0, "retagged": 0}

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_sources
               SET country = NULL, updated_at = now()
             WHERE country = 'ME'
               AND UPPER(COALESCE(region, '')) IN ('MENA', 'MIDDLE EAST', 'MIDDLE-EAST', 'MIDEAST')
        """)
        summary["mena"] = cur.rowcount

        cur.execute("""
            UPDATE news_sources
               SET country = NULL, region = 'global', updated_at = now()
             WHERE feed_url = 'https://dev.to/feed'
        """)
        summary["dev_to"] = cur.rowcount

        # A source whose own-text articles are ~none in its tagged country
        # but overwhelmingly in one other country is mis-tagged.
        report = audit(days=45)
        for r in report:
            if r["credible"] or not r["content_total"]:
                continue
            top_cc, top_n = (r["content_top_country"], r["content_top_share"])
            if top_cc and len(top_cc) == 2 and top_cc.isalpha() and top_cc.isupper() \
                    and top_n >= 0.5 and r["own_country_share"] < 0.05:
                cur.execute("""
                    UPDATE news_sources
                       SET country = %s, updated_at = now()
                     WHERE id = %s AND country IS DISTINCT FROM %s
                """, (top_cc, r["source_id"], top_cc))
                summary["retagged"] += cur.rowcount

        if apply:
            conn.commit()
        else:
            conn.rollback()

    return summary


def content_country_distribution(source_id: int, days: int = 45) -> list[tuple[str, int]]:
    """Countries of the articles this source placed FROM THEIR OWN TEXT.

    Source-based placements are excluded on purpose: they are the thing
    we are auditing, and they are what made the profiles self-reinforcing.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT l.country, COUNT(*)::int AS n
            FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE a.source_id = %s
              AND a.auto_categorize_method IS DISTINCT FROM 'source_fallback'
              AND a.published_at > now() - (%s || ' days')::interval
              AND l.country IS NOT NULL
            GROUP BY l.country
            ORDER BY n DESC
        """, (source_id, days))
        return [(r["country"], r["n"]) for r in cur.fetchall()]


def content_country_distributions(source_ids: list[int], days: int = 45) -> dict[int, list[tuple[str, int]]]:
    """Same as content_country_distribution() for many sources in one query."""
    if not source_ids:
        return {}
    with long_connection() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.source_id, l.country, COUNT(*)::int AS n
            FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE a.source_id = ANY(%s)
              AND a.auto_categorize_method IS DISTINCT FROM 'source_fallback'
              AND a.published_at > now() - (%s || ' days')::interval
              AND l.country IS NOT NULL
            GROUP BY 1, 2
        """, (source_ids, days))
        out: dict[int, list[tuple[str, int]]] = {}
        for r in cur.fetchall():
            out.setdefault(r["source_id"], []).append((r["country"], r["n"]))
        for sid in out:
            out[sid].sort(key=lambda x: -x[1])
        return out


def find_candidates(days: int = 45, min_pileup: int = MIN_PILEUP) -> list[dict]:
    """Sources with a big source-based placement footprint."""
    with long_connection() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.source_id, s.name, s.country, s.region, COUNT(*)::int AS n
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.auto_categorize_method = 'source_fallback'
              AND a.published_at > now() - (%s || ' days')::interval
            GROUP BY 1,2,3,4
            HAVING COUNT(*) >= %s
            ORDER BY COUNT(*) DESC
        """, (days, min_pileup))
        return [dict(r) for r in cur.fetchall()]


def audit(days: int = 45) -> list[dict]:
    """Classify every candidate source: credible country or not."""
    candidates = find_candidates(days)
    dists = content_country_distributions([c["source_id"] for c in candidates], days)
    report = []
    for c in candidates:
        cc = (c["country"] or "").strip().upper()
        region = (c["region"] or "").strip().lower()
        dist = dists.get(c["source_id"], [])
        total = sum(n for _, n in dist)
        own = sum(n for country, n in dist if (country or "").upper() == cc) if cc else 0
        share = (own / total) if total else 0.0

        reasons = []
        if not cc:
            reasons.append("no country")
        elif cc in PSEUDO_COUNTRIES:
            reasons.append(f"country code {cc} is not a country")
        elif cc == "ME" and region in MENA_REGIONS:
            reasons.append("country 'ME' means Middle East here, not Montenegro")
        elif total and own == 0 and dist:
            # Not one of its own-text articles landed in its own country
            # while the bulk of them landed in one other country → the
            # country tag is wrong (e.g. "Mali Actu" tagged Afghanistan).
            top_cc, top_n = dist[0]
            if top_n / total >= 0.5:
                reasons.append(f"none of its articles are in {cc}, "
                               f"{top_cc} holds {top_n / total:.0%}")

        top = dist[0] if dist else ("—", 0)
        report.append({
            "source_id": c["source_id"],
            "name": c["name"],
            "country": c["country"],
            "region": c["region"],
            "fallback_placements": c["n"],
            "content_total": total,
            "content_top_country": top[0],
            "content_top_share": (top[1] / total) if total else 0.0,
            "own_country_share": share,
            "credible": not reasons,
            "reason": "; ".join(reasons),
        })
    return report


def reset_pileups(report: list[dict], apply: bool = False, limit: int = 0) -> int:
    """Un-locate the source-based placements of non-credible sources.

    The articles go back to the fast path (auto_categorize) so they are
    placed from their own text — or left un-located, which is the honest
    answer for a story that never says where it happened.
    """
    targets = [r for r in report if not r["credible"]]
    if limit:
        targets = targets[:limit]
    if not targets:
        return 0

    affected = 0
    with long_connection() as conn, conn.cursor() as cur:
        # A 50k-row UPDATE on a 1.6M-row table with indexes blows past the
        # default statement timeout — do it source by source.
        for r in targets:
            cur.execute("""
                UPDATE news_articles
                   SET location_id = NULL,
                       location_text = NULL,
                       extracted_location = NULL,
                       extracted_lat = NULL,
                       extracted_lng = NULL,
                       extracted_event_type = NULL,
                       location_confidence = NULL,
                       suggested_lat = NULL,
                       suggested_lng = NULL,
                       suggested_place_name = NULL,
                       geocoded_at = NULL,
                       auto_categorize_city_id = NULL,
                       auto_categorize_city_label = NULL,
                       auto_categorize_status = 'no_match',
                       auto_categorize_confidence = NULL,
                       auto_categorize_method = NULL,
                       auto_categorized_at = NULL,
                       status = 'pending'
                 WHERE source_id = %s
                   AND auto_categorize_method = 'source_fallback'
            """, (r["source_id"],))
            affected += cur.rowcount
        if apply:
            conn.commit()
        else:
            conn.rollback()
    return affected


def reset_location(location_name: str, apply: bool = False) -> int:
    """Reset the source-based placements at one location.

    A location row can become a fake hotspot when the *profile* of a
    source picked a false-positive city ("Fargo, ND" from the text
    "Wells Fargo"): the fallback then pinned the source's whole output
    there. Those placements are reset so the articles are placed from
    their own text again.
    """
    with long_connection() as conn, conn.cursor() as cur:
        cur.execute("SET LOCAL enable_seqscan = off")
        cur.execute("""
            UPDATE news_articles a
               SET location_id = NULL,
                   location_text = NULL,
                   extracted_location = NULL,
                   extracted_lat = NULL,
                   extracted_lng = NULL,
                   extracted_event_type = NULL,
                   location_confidence = NULL,
                   suggested_lat = NULL,
                   suggested_lng = NULL,
                   suggested_place_name = NULL,
                   geocoded_at = NULL,
                   auto_categorize_city_id = NULL,
                   auto_categorize_city_label = NULL,
                   auto_categorize_status = 'no_match',
                   auto_categorize_confidence = NULL,
                   auto_categorize_method = NULL,
                   auto_categorized_at = NULL,
                   status = 'pending'
             WHERE a.auto_categorize_method = 'source_fallback'
               AND a.location_id IN (
                     SELECT id FROM news_locations WHERE place_name = %s
               )
        """, (location_name,))
        affected = cur.rowcount
        if apply:
            conn.commit()
        else:
            conn.rollback()
    return affected


def main():
    parser = argparse.ArgumentParser(description="Repair source-based placement pileups")
    parser.add_argument("--dry-run", action="store_true", help="Only report (default)")
    parser.add_argument("--apply", action="store_true", help="Reset the polluted placements")
    parser.add_argument("--fix-sources", action="store_true", help="Repair source country metadata")
    parser.add_argument("--days", type=int, default=45, help="Window in days (default 45)")
    parser.add_argument("--min-pileup", type=int, default=MIN_PILEUP,
                        help=f"Minimum source-based placements to audit (default {MIN_PILEUP})")
    parser.add_argument("--limit", type=int, default=0, help="Only touch N sources")
    parser.add_argument("--reset-location", metavar="PLACE",
                        help="Reset the source-based placements at one location "
                             "(e.g. 'Fargo, US')")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    apply = args.apply and not args.dry_run

    if args.reset_location:
        n = reset_location(args.reset_location, apply=apply)
        log.info("%s %d source-based placements at %r",
                 "RESET" if apply else "[dry run] would reset", n, args.reset_location)
        if not apply:
            log.info("Re-run with --apply to persist.")
        return

    if args.fix_sources:
        s = fix_source_countries(apply=apply)
        log.info("country metadata%s: MENA-as-ME cleared=%d, dev.to cleared=%d, retagged=%d",
                 " (applied)" if apply else " (dry run)", s["mena"], s["dev_to"], s["retagged"])
        if not apply:
            log.info("  re-run with --fix-sources --apply to persist")

    report = audit(days=args.days)
    bad = [r for r in report if not r["credible"]]
    log.info("\nAudited %d sources with >= %d source-based placements: %d are mis-tagged",
             len(report), args.min_pileup, len(bad))
    log.info("%-28s %-6s %9s %8s %8s  %s", "source", "country", "fallback", "content", "own%", "reason")
    for r in sorted(bad, key=lambda x: -x["fallback_placements"])[:40]:
        log.info("%-28s %-6s %9d %8d %7.0f%%  %s",
                 r["name"][:28], str(r["country"] or "-")[:6], r["fallback_placements"],
                 r["content_total"], r["own_country_share"] * 100, r["reason"])

    affected = reset_pileups(report, apply=apply, limit=args.limit)
    if affected:
        log.info("\n%s %d source-based placements of mis-tagged sources",
                 "RESET" if apply else "[dry run] would reset", affected)
    else:
        log.info("\nNothing to reset.")
    if not apply:
        log.info("Re-run with --apply to persist.")


if __name__ == "__main__":
    main()
