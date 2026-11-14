#!/usr/bin/env python3
"""
Worker Health Monitor - Lightweight monitoring for fetch worker crashes.

This script checks for:
1. Stale fetch leases (worker crashed leaving fetch_in_progress=true)
2. Sources stuck in pending robots.txt check
3. Sources with too many consecutive errors

Usage:
    python -m worker.health_monitor          # Check and report
    python -m worker.health_monitor --fix    # Auto-clear stale leases
    python -m worker.health_monitor --cron   # For cron: check and email if issues found
"""

import argparse
import os
import sys
from datetime import datetime


def get_health_stats():
    """Get current worker health statistics."""
    from worker.db import connect

    stats = {}

    with connect() as conn, conn.cursor() as cur:
        # Stale fetch leases
        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_sources
            WHERE fetch_in_progress = TRUE
              AND (lease_token IS NULL OR lease_expires_at < now())
        """)
        stats['stale_leases'] = cur.fetchone()['count']

        # Pending robots check for too long
        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_sources
            WHERE robots_status = 'pending'
              AND created_at < now() - INTERVAL '24 hours'
              AND active = TRUE
        """)
        stats['stale_pending'] = cur.fetchone()['count']

        # High error count
        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_sources
            WHERE error_count > 10
              AND active = TRUE
        """)
        stats['high_errors'] = cur.fetchone()['count']

        # Never fetched sources (created but never attempted)
        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_sources
            WHERE last_failure_at IS NULL
              AND last_success_at IS NULL
              AND created_at < now() - INTERVAL '1 hour'
              AND active = TRUE
        """)
        stats['never_fetched'] = cur.fetchone()['count']

        # Total active sources
        cur.execute("SELECT COUNT(*) as count FROM news_sources WHERE active = TRUE")
        stats['total_active'] = cur.fetchone()['count']

        # Sources fetched in last hour
        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_sources
            WHERE last_success_at > now() - INTERVAL '1 hour'
        """)
        stats['fetched_last_hour'] = cur.fetchone()['count']

        # ── Pipeline-stage freshness (added 2026-09-29) ────────────────────
        # Every check above watches the FETCH layer, which is why the
        # 2026-09-29 outage was silent for 20+ hours: fetch_all()'s claim loop
        # never returned, so run.py never reached auto_categorize / geocode,
        # yet fetch kept inserting and every stat above looked healthy. The
        # real signal is the stage AFTER fetch going quiet while a backlog
        # piles up in front of it.
        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_articles
            WHERE auto_categorized_at IS NULL AND status = 'pending'
        """)
        stats['pending_backlog'] = cur.fetchone()['count']

        cur.execute("""
            SELECT COUNT(*) as count
            FROM news_articles
            WHERE auto_categorized_at > now() - INTERVAL '30 minutes'
        """)
        stats['autocat_last_30m'] = cur.fetchone()['count']

        # Minutes since auto_categorize last committed anything (NULL if the
        # backlog is empty — nothing to do is not an outage).
        cur.execute("""
            SELECT EXTRACT(EPOCH FROM (now() - MAX(auto_categorized_at))) / 60.0
                    AS minutes
            FROM news_articles
        """)
        row = cur.fetchone()
        stats['autocat_stale_minutes'] = float(row['minutes']) if row and row['minutes'] is not None else None

    return stats


def pipeline_stuck(stats: dict) -> bool:
    """True when articles are queuing up faster than auto_categorize drains.

    Requires BOTH a real backlog and a completely quiet last 30 minutes, so an
    idle-but-healthy system (empty queue) never trips it.
    """
    return bool(stats.get('pending_backlog', 0) > 1000
                and stats.get('autocat_last_30m', 0) == 0)


def get_stale_leases_detail(limit=20):
    """Get details of sources with stale leases."""
    from worker.db import connect

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, feed_url, lease_expires_at, lease_token
            FROM news_sources
            WHERE fetch_in_progress = TRUE
              AND (lease_token IS NULL OR lease_expires_at < now())
            ORDER BY lease_expires_at ASC
            LIMIT %s
        """, (limit,))
        return list(cur.fetchall())


def auto_recover():
    """Attempt automatic recovery from stale leases."""
    from worker.fetch import cleanup_stale_leases
    return cleanup_stale_leases()


def main():
    parser = argparse.ArgumentParser(description='Worker Health Monitor')
    parser.add_argument('--fix', action='store_true', help='Auto-clear stale leases')
    parser.add_argument('--cron', action='store_true', help='Cron mode: exit 1 if problems found')
    parser.add_argument('--verbose', '-v', action='store_true', help='Show detailed info')
    parser.add_argument('--cpu-guard', action='store_true',
                        help='Evaluate CPU load and set/clear the cooperative '
                             'cycle-pause flag (run from the watchdog cron)')
    parser.add_argument('--quiet', '-q', action='store_true',
                        help='Only print on state changes (for */2 cron lines, '
                             'as documented in deploy/systemd-limits/README.md)')
    args = parser.parse_args()

    # ── Load guard: spot a saturated box from the CPU side and stop piling on ──
    if args.cpu_guard:
        from worker.load_guard import evaluate, top_cpu_processes
        st = evaluate(verbose=not args.quiet)
        if not args.quiet or st['changed']:
            print(f"load guard: {st['load_frac'] * 100:.0f}% of {st['cores']} cores — "
                  f"{'PAUSED' if st['paused'] else 'running'}"
                  + ('  (state changed)' if st['changed'] else ''))
        if st['changed'] and st['paused']:
            print("  top CPU consumers:")
            for pct, cmd in top_cpu_processes():
                print(f"    {pct:5.1f}%  {cmd}")
        # non-zero exit only when we just PAUSED so cron/journal flag it loudly
        raise SystemExit(1 if (st['changed'] and st['paused']) else 0)

    stats = get_health_stats()
    stuck = pipeline_stuck(stats)
    has_problems = stats['stale_leases'] > 0 or stats['stale_pending'] > 10 or stuck

    print(f"=== Worker Health Report ===")
    print(f"Generated: {datetime.now().isoformat()}")
    print(f"Total active sources: {stats['total_active']}")
    print(f"Fetched in last hour: {stats['fetched_last_hour']}")
    print()
    print(f"Stale fetch leases: {stats['stale_leases']}")
    print(f"Stale pending checks: {stats['stale_pending']}")
    print(f"High error sources: {stats['high_errors']}")
    print(f"Never fetched: {stats['never_fetched']}")
    print()
    stale_min = stats.get('autocat_stale_minutes')
    stale_txt = f"{stale_min:.0f} min ago" if stale_min is not None else "never"
    print(f"Pending backlog (awaiting auto_categorize): {stats['pending_backlog']}")
    print(f"Auto-categorized in last 30 min: {stats['autocat_last_30m']}")
    print(f"Last auto-categorize commit: {stale_txt}")
    if stuck:
        print()
        print("ERROR: PIPELINE STUCK AFTER FETCH — articles are piling up at "
              "status='pending' (no coordinates, so they never reach the map) "
              "while auto_categorize has been silent for 30+ min. This is the "
              "2026-09-29 signature: fetch_all() not returning. Check "
              "`journalctl -u xyzo-fast-fetcher` and worker/fetch.py's claim "
              "loop.")

    if args.verbose and stats['stale_leases'] > 0:
        print()
        print(f"Stale lease details (top {min(10, stats['stale_leases'])}):")
        stale = get_stale_leases_detail()
        for s in stale:
            print(f"  - {s['name']}: {s['feed_url']}")
            print(f"    Lease expired: {s['lease_expires_at']}")

    if args.fix:
        print()
        print("Attempting auto-recovery...")
        cleaned = auto_recover()
        print(f"Cleared {cleaned} stale lease(s)")

    if args.cron:
        # Exit with error if there are problems
        if has_problems:
            print()
            print("ERROR: Worker health issues detected!")
            sys.exit(1)
        else:
            print()
            print("OK: Worker healthy")
            sys.exit(0)


if __name__ == "__main__":
    main()
