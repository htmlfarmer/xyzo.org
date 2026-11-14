"""Automated Community Triage Engine.

Processes user quality reports and location re-evaluation requests, auto-resolving
map-click coordinates, detecting paywalled articles, and auto-queueing pins that receive
multiple community mislocation reports.

CLI Usage:
    python -m worker.triage_community [--apply] [--verbose]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

from .db import connect
from .re_evaluate import _decode_coords, _precision_for_radius, _apply_coord_suggestion, _mark_completed
from .paywall import detect_paywall

log = logging.getLogger("xyzo.triage_community")


def triage_queued_requests(*, apply: bool = True) -> int:
    """Auto-resolve pending map-click requests (`coords:lat,lng`)."""
    resolved_count = 0
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, pin_id, article_id, kind, user_place
            FROM news_re_evaluate_requests
            WHERE status = 'queued'
        """)
        rows = cur.fetchall()

    for req in rows:
        user_place = req["user_place"] or ""
        coords = _decode_coords(user_place)
        if coords is not None and req["pin_id"] and req["article_id"]:
            if apply:
                precision = _precision_for_radius(coords["radius_km"])
                confidence = coords.get("confidence") or 0.85
                res = _apply_coord_suggestion(
                    pin_id=req["pin_id"],
                    article_id=req["article_id"],
                    coords=coords,
                    precision=precision,
                    confidence=confidence,
                )
                _mark_completed(req["id"], res)
            resolved_count += 1
    return resolved_count


def triage_quality_reports(*, apply: bool = True) -> dict[str, int]:
    """Scan quality reports to flag paywalled articles and auto-queue mislocated pins."""
    paywalls_flagged = 0
    re_eval_queued = 0

    with connect() as conn, conn.cursor() as cur:
        # 1. Check for paywall reports
        cur.execute("""
            SELECT r.id, r.article_id, a.url, a.body, a.title
            FROM news_quality_reports r
            JOIN news_articles a ON a.id = r.article_id
            WHERE r.report_type IN ('paywall', 'login_required')
        """)
        paywall_reports = cur.fetchall()

        for r in paywall_reports:
            pw_res = detect_paywall(url=r["url"], body=r["body"] or r["title"] or "")
            if pw_res["is_paywalled"]:
                paywalls_flagged += 1

        # 2. Find articles with multiple mislocation reports
        cur.execute("""
            SELECT r.article_id, COUNT(*) as report_count
            FROM news_quality_reports r
            WHERE r.report_type IN ('misleading', 'false_info', 'rerun_requested')
              AND r.article_id IS NOT NULL
            GROUP BY r.article_id
            HAVING COUNT(*) >= 2
        """)
        hotspot_articles = cur.fetchall()

        for ha in hotspot_articles:
            art_id = ha["article_id"]
            if apply:
                # Find matching pin if available
                cur.execute("SELECT id FROM pins WHERE id = %s LIMIT 1", (art_id,))
                pin_row = cur.fetchone()
                pin_id = pin_row["id"] if pin_row else art_id
                cur.execute("""
                    INSERT INTO news_re_evaluate_requests (pin_id, article_id, kind, user_place, status)
                    VALUES (%s, %s, 're_evaluate', 'auto-queued from community quality reports', 'queued')
                    ON CONFLICT DO NOTHING
                """, (pin_id, art_id))
                re_eval_queued += 1

        if apply and re_eval_queued > 0:
            conn.commit()

    return {"paywalls_flagged": paywalls_flagged, "re_eval_queued": re_eval_queued}


def run_triage(*, apply: bool = True) -> dict[str, Any]:
    resolved = triage_queued_requests(apply=apply)
    report_stats = triage_quality_reports(apply=apply)
    return {
        "applied": apply,
        "resolved_requests": resolved,
        **report_stats,
    }


def cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m worker.triage_community",
        description="Automated triage engine for community reports and re-evaluations.",
    )
    p.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run)")
    p.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)
    res = run_triage(apply=args.apply)
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(cli())
