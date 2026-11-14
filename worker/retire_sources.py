#!/usr/bin/env python3
"""Source dormancy — the "zero-value, zero-demand" watchlist, built from
our own records.

STANCE (owner decision 2026-09-26): DO NOT deactivate yet. The user base is
too small for "no demand" to mean "no value" — it mostly means "no users
there YET". With value-weighted backoff in place (worker/fetch.py), a
dormant source costs ~1 poll per 8 days, so keeping the whole fleet alive is
cheap insurance on tomorrow's coverage. This tool OBSERVES and REPORTS;
`--apply` exists for the day demand data is statistically meaningful.

Policy for CANDIDATES (never succeeded, never produced):
  * active, not deleted
  * last_success_at IS NULL  (never fetched successfully)
  * zero articles ever in news_articles
  * not created in the last 14 days (give new adds a grace window)
  * been polled at least 5 times in the last 30 days (prove it was tried)

These cost real money: the current 1,121 candidates generated 430,668 failed
poll observations in the last 14 days — ~97% of all fetch errors — while
contributing exactly zero articles.

Value/demand note: candidates have produced no content, so user demand cannot
favor them; demand data (news_location_views) is reported alongside for the
ACQUISITION side of the same decision (which countries users actually read).

Usage:
    python3 -m worker.retire_sources --check              # report only (default)
    python3 -m worker.retire_sources --check --report docs/SOURCE_RETIREMENT.md
    python3 -m worker.retire_sources --apply              # deactivate candidates
    python3 -m worker.retire_sources --revive 5           # random revival probe
Rollback:
    UPDATE news_sources SET active = TRUE, locality = NULL
    WHERE locality = 'retired_never_produced';
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from .db import connect

RETIRE_WHERE = """
    active = TRUE
    AND deleted_at IS NULL
    AND last_success_at IS NULL
    AND created_at < now() - INTERVAL '14 days'
    AND NOT EXISTS (SELECT 1 FROM news_articles a WHERE a.source_id = news_sources.id)
    AND (SELECT count(*) FROM source_poll_observations o
         WHERE o.source_id = news_sources.id
           AND o.polled_at > now() - INTERVAL '30 days') >= 5
"""


def candidates(cur) -> list[dict]:
    cur.execute(f"""
        SELECT id, name, feed_url, source_type, country, locality, created_at, error_count
        FROM news_sources
        WHERE {RETIRE_WHERE}
        ORDER BY error_count DESC
    """)
    return cur.fetchall()


def demand_snapshot(cur) -> dict:
    """What humans actually READ, from the local pre-aggregated rankings table
    (news_location_rankings — learn.py's zoom-tracking loop). No FDW joins."""
    out: dict = {"top_countries": [], "gap_cities": 0, "views_30d": 0, "sessions": 0,
                 "demand_ccs": set()}
    try:
        cur.execute("""
            SELECT country_code AS cc, sum(views_30d)::int AS views
            FROM news_location_rankings
            GROUP BY 1 HAVING sum(views_30d) > 0 ORDER BY 2 DESC LIMIT 40""")
        out["top_countries"] = cur.fetchall()
        out["demand_ccs"] = {r["cc"] for r in out["top_countries"] if r["cc"]}
        cur.execute("""SELECT count(*)::int AS n FROM news_location_rankings
                       WHERE views_30d > 0 AND (has_coverage IS NOT TRUE)""")
        out["gap_cities"] = cur.fetchone()["n"]
        cur.execute("""SELECT count(*)::int AS n, count(DISTINCT session_id)::int AS s
                       FROM news_location_views
                       WHERE created_at > now() - INTERVAL '30 days'""")
        row = cur.fetchone()
        out["views_30d"], out["sessions"] = row["n"], row["s"]
    except Exception:
        pass
    return out


def report(rows: list[dict], demand: list[dict]) -> str:
    by_type: dict[str, int] = {}
    by_country: dict[str, int] = {}
    for r in rows:
        by_type[r["source_type"] or "?"] = by_type.get(r["source_type"] or "?", 0) + 1
        cc = (r["country"] or "??").upper()
        by_country[cc] = by_country.get(cc, 0) + 1

    tier_b = [r for r in rows if (r["country"] or "").upper() in demand.get("demand_ccs", set())]
    tier_r = [r for r in rows if r not in tier_b]
    rows = tier_r  # worst-cost listing follows the retire tier
    lines = [
        f"# Source Retirement List — {datetime.now(timezone.utc):%Y-%m-%d}",
        "",
        f"**{len(rows) + len(tier_b)} active sources have NEVER succeeded and contributed ZERO articles.**",
        "",
        "> STANCE: keep them ALL active (owner decision 2026-09-26) — too few users",
        "> today to judge demand; deep backoff already caps their cost at ~1 poll/8d.",
        "> Revisit `--apply` when 30-day sessions are an order of magnitude larger.",
        "",
        "Split by measured demand signal:",
        "",
        f"- **Tier B — KEEP & REPAIR ({len(tier_b)})**: zero successes but from countries with",
        "  real 30-day view demand (e.g. BBC Malayalam, Dawn, Jakarta Post). These are",
        "  likely blocked/renamed feeds, not garbage. Backoff caps their cost automatically;",
        "  they need a feed-URL/UA repair pass, not retirement.",
        f"- **Tier R — DORMANT ({len(rows)})**: zero successes, zero articles, no demand signal",
        "  yet. Kept active, on automatic deep backoff. `--revive`-style probes and the",
        "  weekly report watch them; `--apply` would deactivate — deliberately unused.",
        "",
        "## Breakdown",
        f"- by type: {sorted(by_type.items(), key=lambda x: -x[1])}",
        f"- top countries affected: {sorted(by_country.items(), key=lambda x: -x[1])[:15]}",
        "",
        "## Worst cost first (top 30)",
        "",
        "| id | name | type | country | errors | added |",
        "|---|---|---|---|---|---|",
    ]
    for r in rows[:30]:
        lines.append(
            f"| {r['id']} | {str(r['name'])[:40]} | {r['source_type']} | "
            f"{(r['country'] or '?')[:2]} | {r['error_count']} | "
            f"{r['created_at']:%Y-%m-%d} |"
        )
    if tier_b:
        lines += ["", "## Tier B — keep & repair (top 20 by errors)", "",
                  "| id | name | type | country | errors |", "|---|---|---|---|---|"]
        for r in tier_b[:20]:
            lines.append(f"| {r['id']} | {str(r['name'])[:40]} | {r['source_type']} | "
                         f"{(r['country'] or '?')[:2]} | {r['error_count']} |")
    if demand.get("top_countries"):
        lines += ["", "## Demand check — what humans actually read (30d views by country)", "",
                  ", ".join(f"{d['cc']}: {d['views']:,}" for d in demand["top_countries"]),
                  f"\n- Tracked locations: {demand['views_30d']:,} views from "
                  f"{demand['sessions']:,} sessions in 30d",
                  f"- Cities people LOOKED AT but we have no coverage for: {demand['gap_cities']:,}",
                  "", "Acquisition focus: those gap cities are the next sources to hunt —",
                  "demand already exists, supply is zero. Retirement frees the budget for it."]
    lines += ["", "## Rollback", "",
              "```sql",
              "UPDATE news_sources SET active = TRUE, locality = NULL",
              "WHERE locality = 'retired_never_produced';",
              "```"]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--check", action="store_true", help="report only (default)")
    g.add_argument("--apply", action="store_true",
                   help="DEACTIVATE Tier R (default stance is RETAIN — requires --force too)")
    g.add_argument("--revive", type=int, metavar="N", help="re-activate N random retired probes")
    ap.add_argument("--report", metavar="PATH", help="write markdown report")
    ap.add_argument("--force", action="store_true",
                    help="required with --apply: owner stance is RETAIN until demand data is meaningful")
    args = ap.parse_args(argv)

    with connect() as conn, conn.cursor() as cur:
        if args.revive:
            cur.execute("""
                UPDATE news_sources
                SET active = TRUE, locality = NULL,
                    consecutive_failures = 0, next_retry_at = NULL,
                    last_polled_at = NULL, error_count = 0
                WHERE id IN (
                    SELECT id FROM news_sources
                    WHERE locality = 'retired_never_produced' AND active = FALSE
                    ORDER BY random() LIMIT %s
                )
                RETURNING id, name
            """, (args.revive,))
            rows = cur.fetchall()
            conn.commit()
            print(f"revived {len(rows)} probes:", [r['name'] for r in rows])
            return 0

        rows = candidates(cur)
        demand = demand_snapshot(cur)
        n_b = sum(1 for r in rows if (r["country"] or "").upper() in demand["demand_ccs"])
        print(f"retirement candidates: {len(rows)} (Tier B keep&repair: {n_b}, Tier R retire: {len(rows) - n_b})")
        if args.report:
            text = report(rows, demand)
            with open(args.report, "w") as f:
                f.write(text)
            print(f"report written: {args.report}")

        if args.apply and not args.force:
            print("REFUSED: owner stance 2026-09-26 = retain-and-observe (backoff caps cost).")
            print("This fleet is too small to judge demand. Pass --force to deactivate anyway.")
            return 2
        if args.apply:
            tier_b_ids = [r["id"] for r in rows
                          if (r["country"] or "").upper() in demand["demand_ccs"]]
            if tier_b_ids:
                cur.execute("UPDATE news_sources SET locality = 'repair_blocked_high_demand' "
                            "WHERE id = ANY(%s)", (tier_b_ids,))
                conn.commit()
                print(f"Tier B tagged repair-and-keep: {len(tier_b_ids)} (stay active, backoff caps cost)")
            rows = [r for r in rows if r["id"] not in set(tier_b_ids)]
            ids = [r["id"] for r in rows]
            if not ids:
                print("nothing to apply")
                return 0
            cur.execute(
                "UPDATE news_sources SET active = FALSE, locality = 'retired_never_produced', "
                "next_retry_at = NULL, consecutive_failures = 0 "
                "WHERE id = ANY(%s)", (ids,))
            conn.commit()
            print(f"DEACTIVATED {len(ids)} sources — rollback SQL is in the report")
        else:
            print("RETAIN-AND-OBSERVE stance (no writes). --apply [--force] exists for later.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
