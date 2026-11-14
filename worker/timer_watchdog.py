#!/usr/bin/env python3
"""
Timer Watchdog - Auto-restarts dead systemd timers and hung services.

This script checks that critical XYZO timers are running and restarts any that are dead.
It also checks if services have been running for too long (indicating a hang).

Run via cron every 5 minutes.

Usage:
    python -m worker.timer_watchdog      # Check and report
    python -m worker.timer_watchdog --fix  # Auto-restart dead/hung services
    python -m worker.timer_watchdog --cron # For cron: check, email if issues, auto-fix
"""
import argparse
import subprocess
import sys
from datetime import datetime, timezone, timedelta


CRITICAL_SERVICES = [
    # Thresholds must exceed the MEASURED worst-case cycle (2026-09-26
    # audit): a full fast cycle spans 40-60 min of host-group fetches;
    # story-link ran 1h43m. Old values (300s/600s) would have "fixed"
    # perfectly healthy long cycles by killing them mid-flight — and the
    # killed cycle's leases would only self-heal via TTL. (FIX_NOTES 9)
    ("xyzo-fast-fetcher", 5400),     # 90 min max
    ("xyzo-fetcher", 5400),          # 90 min max
    ("xyzo-nlp-extract", 1800),      # 30 min max
    ("xyzo-nn-infer", 900),          # 15 min max (built-in 10-min timeout)
    ("xyzo-story-link", 7200),       # 120 min max
    ("xyzo-nn-batch-links", 1800),   # 30 min max
]

CRITICAL_TIMERS = [
    "xyzo-fast-fetcher.timer",
    "xyzo-nlp-extract.timer",
    "xyzo-nn-infer.timer",
    "xyzo-story-link.timer",
    "xyzo-nn-batch-links.timer",
    # Added 2026-11-01: graph-features and nightly had been failing with
    # NO watcher at all; trending joined them once the `failed` check
    # existed (it had been failing unnoticed too).
    "xyzo-graph-features.timer",
    "xyzo-nightly.timer",
    "xyzo-trending.timer",
]

# Units whose `failed` state is safe to clear AND re-run from here.
#
# A failed ONESHOT is not "stuck" (it is not running) and not a dead
# timer (the timer is fine) — so neither existing check could ever see
# it. Re-running is only safe where the job is idempotent and short.
#   graph-features  ~6 min, rewrites one table from source data
#   trending        ~30 min, four independent aggregate producers
# nightly is deliberately ABSENT: it is a 4-hour full AI cycle with a
# 3 AM slot, so restarting it off-schedule would compete with the
# fetchers for hours. It is reported, never auto-restarted.
AUTO_RECOVER_FAILED = {
    "xyzo-graph-features.service",
    "xyzo-trending.service",
}


def get_timer_status(timer_name: str) -> dict:
    """Get status of a systemd timer."""
    result = subprocess.run(
        ["systemctl", "is-active", timer_name],
        capture_output=True, text=True
    )
    is_active = result.returncode == 0 and result.stdout.strip() == "active"

    # FIX 2026-11-14: same broken property as get_service_status() —
    # `ActiveEnterTimestampUSec` does not exist on this systemd (252) and
    # returns empty output, so `last_active` was always None. Use the
    # monotonic variant (raw µs since boot) and convert with /proc/uptime.
    result = subprocess.run(
        ["systemctl", "show", timer_name,
         "--property=ActiveEnterTimestampMonotonic"],
        capture_output=True, text=True
    )
    last_active = None
    mono_usec = None
    for line in result.stdout.splitlines():
        if "=" in line:
            _, val = line.split("=", 1)
            if val.strip().lstrip("-").isdigit():
                mono_usec = int(val)
                break
    if mono_usec is not None and mono_usec > 0:
        try:
            with open("/proc/uptime") as fh:
                uptime_sec = float(fh.read().split()[0])
            age_sec = uptime_sec - (mono_usec / 1_000_000)
            last_active = datetime.now(timezone.utc) - timedelta(seconds=age_sec)
        except (OSError, ValueError, OverflowError):
            last_active = None

    return {
        "name": timer_name,
        "is_active": is_active,
        "last_active": last_active,
    }


def get_service_status(service_name: str) -> dict:
    """Get status of a systemd service - check if hung."""
    # Get active state
    result = subprocess.run(
        ["systemctl", "is-active", service_name],
        capture_output=True, text=True
    )
    is_active = result.returncode == 0 and result.stdout.strip() == "active"

    # Get start timestamp.
    #
    # FIX 2026-11-14: this queried `ActiveEnterTimestampUSec`, which is
    # NOT a property on this systemd (252) — `systemctl show --property=
    # ActiveEnterTimestampUSec` returns empty output with rc=0. So
    # `started_at` was ALWAYS None, check_service_stuck() ALWAYS took the
    # `return False, "unknown start time"` early exit, and every threshold
    # in CRITICAL_SERVICES was dead code. The watchdog printed
    #     ✅ OK | xyzo-fetcher
    #          unknown start time
    # for a service that had actually been stuck in kernel reclaim
    # (__mem_cgroup_handle_over_high) for 3h10m against a 90-minute
    # threshold — 2.2x over and invisible.
    #
    # The properties that DO exist here are `ActiveEnterTimestamp`
    # (locale-formatted string, unsafe to parse) and
    # `ActiveEnterTimestampMonotonic` (microseconds since boot, locale
    # independent). Use the monotonic value and convert it with
    # /proc/uptime, which is also locale independent.
    started_at = None
    result = subprocess.run(
        ["systemctl", "show", service_name,
         "--property=ActiveEnterTimestampMonotonic"],
        capture_output=True, text=True
    )
    mono_usec = None
    for line in result.stdout.splitlines():
        if "=" in line:
            _, val = line.split("=", 1)
            if val.strip().lstrip("-").isdigit():
                mono_usec = int(val)
                break
    if mono_usec is not None and mono_usec > 0:
        try:
            with open("/proc/uptime") as fh:
                uptime_sec = float(fh.read().split()[0])
            # Both are "since boot": monotonic is µs, uptime is s.
            age_sec = uptime_sec - (mono_usec / 1_000_000)
            started_at = datetime.now(timezone.utc) - timedelta(seconds=age_sec)
        except (OSError, ValueError, OverflowError):
            started_at = None

    return {
        "name": service_name,
        "is_active": is_active,
        "started_at": started_at,
    }


def check_service_stuck(service_name: str, max_seconds: int) -> tuple[bool, str]:
    """Check if a service has been running too long (stuck)."""
    status = get_service_status(service_name)

    if not status["is_active"]:
        return False, "not running"

    if status["started_at"] is None:
        return False, "unknown start time"

    age = datetime.now(timezone.utc) - status["started_at"]
    if age.total_seconds() > max_seconds:
        return True, f"running for {age.total_seconds() / 60:.1f} min (max {max_seconds}s)"

    return False, f"OK ({age.total_seconds() / 60:.1f} min)"


def check_failed_units() -> list[dict]:
    """Units in systemd's `failed` state (i.e. exited non-zero).

    This is the check that was missing entirely until 2026-11-01, and
    its absence is why two services could be red with nobody noticing:

      * ``check_service_stuck()`` only inspects services that are
        RUNNING — a broken oneshot has already exited, so it reports
        "not running" and passes.
      * ``check_all_timers()`` inspects the TIMER, which is perfectly
        healthy; it fired, the service failed, the timer waits for the
        next slot.
      * no script in this repo ran ``systemctl --failed`` at all.

    Consequences before this existed: ``xyzo-graph-features`` failed
    every hour while ``news_event_graph_features`` sat frozen at
    2026-10-02 (a month of stale graph scores in ``/api/feed/*``), and
    ``xyzo-nightly`` died at learn.py:1189 every night, silently
    skipping ``location_rankings`` and the whole aggregates refresh.

    Scoped to ``xyzo-*``: this box hosts many vhosts and a failed unit
    belonging to one of them is not this watchdog's business.
    """
    result = subprocess.run(
        ["systemctl", "--failed", "--no-legend", "--no-pager"],
        capture_output=True, text=True
    )
    units = []
    for line in result.stdout.splitlines():
        # ``--no-legend`` still prefixes each row with a bullet glyph.
        parts = line.replace("●", "").split()
        if parts and parts[0].startswith("xyzo-"):
            units.append({"name": parts[0]})
    return units


def unit_is_active(unit_name: str) -> bool:
    """True if the unit is currently running (or activating).

    Needed because a unit can be left in the `failed` state while a
    subsequent run is ALREADY in flight. On 2026-11-14 that produced
    three simultaneous copies of the same ``compute_event_graph_features``
    query against the 69M-row ``news_story_links`` table, each with its
    own set of parallel workers — 12 PostgreSQL backends pegged at 100%
    CPU, which is what drove the box into load 21.
    """
    result = subprocess.run(
        ["systemctl", "is-active", unit_name],
        capture_output=True, text=True
    )
    return result.stdout.strip() in ("active", "activating")


def recover_failed(units: list[dict]) -> list[str]:
    """Clear `failed` and re-run the units we know are safe to re-run.

    ``--no-block`` matters: this watchdog runs from a ``*/2`` cron, and
    ``systemctl start`` on a oneshot BLOCKS until the job finishes
    (~6 min for graph-features, ~30 min for trending) — a blocking
    recovery would pile up overlapping watchdog runs. With
    ``--no-block`` systemd owns the job and the next cron tick simply
    re-checks its state.

    The ``is-active`` guard matters even more. ``systemctl start`` on a
    unit that is already running is a NO-OP for a Type=oneshot that is
    mid-run, so it does not create a duplicate by itself — but the
    watchdog would still clear the `failed` flag of a unit whose PREVIOUS
    run failed while the CURRENT run is still going, and it would keep
    re-triggering the timer path. Guarding on `is-active` keeps exactly
    one instance of each job alive.
    """
    recovered = []
    for u in units:
        if u["name"] not in AUTO_RECOVER_FAILED:
            continue
        if unit_is_active(u["name"]):
            # A run is already in flight — starting another would double
            # the database load. Clear the stale failed flag only.
            subprocess.run(
                ["sudo", "systemctl", "reset-failed", u["name"]],
                capture_output=True, text=True
            )
            print(f"SKIP: {u['name']} is already running; not starting a duplicate")
            continue
        reset = subprocess.run(
            ["sudo", "systemctl", "reset-failed", u["name"]],
            capture_output=True, text=True
        )
        start = subprocess.run(
            ["sudo", "systemctl", "start", "--no-block", u["name"]],
            capture_output=True, text=True
        )
        if reset.returncode == 0 and start.returncode == 0:
            recovered.append(u["name"])
        else:
            print(f"FAIL: could not recover {u['name']}: "
                  f"{(reset.stderr or start.stderr).strip()}")
    return recovered


def check_all_timers() -> list[dict]:
    """Check status of all critical timers."""
    return [get_timer_status(t) for t in CRITICAL_TIMERS]


def check_all_services() -> list[dict]:
    """Check status of all critical services."""
    results = []
    for service_name, max_seconds in CRITICAL_SERVICES:
        is_stuck, reason = check_service_stuck(service_name, max_seconds)
        status = get_service_status(service_name)
        results.append({
            "name": service_name,
            "is_stuck": is_stuck,
            "reason": reason,
            "started_at": status["started_at"],
        })
    return results


def auto_restart_dead(timers: list[dict], stuck_services: list[dict] = None) -> tuple[list[str], list[str]]:
    """Restart dead timers and stuck services. Returns (restarted_timers, restarted_services)."""
    restarted_timers = []
    restarted_services = []

    # Restart dead timers
    for timer in timers:
        if not timer["is_active"]:
            result = subprocess.run(
                ["sudo", "systemctl", "restart", timer["name"]],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                restarted_timers.append(timer["name"])
            else:
                print(f"FAIL: Could not restart {timer['name']}: {result.stderr}")

    # Restart stuck services
    if stuck_services:
        for svc in stuck_services:
            if svc["is_stuck"]:
                result = subprocess.run(
                    ["sudo", "systemctl", "stop", svc["name"]],
                    capture_output=True, text=True
                )
                if result.returncode == 0:
                    restarted_services.append(svc["name"])
                # Also restart the timer to schedule a fresh run
                timer_name = svc["name"].replace(".service", ".timer")
                subprocess.run(
                    ["sudo", "systemctl", "restart", timer_name],
                    capture_output=True, text=True
                )

    return restarted_timers, restarted_services


def format_report(timers: list[dict], services: list[dict] = None,
                  restarted_timers: list[str] = None, restarted_services: list[str] = None,
                  failed_units: list[dict] = None,
                  recovered_units: list[str] = None) -> str:
    """Format status as readable report."""
    lines = []
    now = datetime.now(timezone.utc)
    lines.append(f"Watchdog Report - {now.isoformat()}")
    lines.append("=" * 60)

    lines.append("\n⏱️  TIMERS:")
    for t in timers:
        status = "✅ ACTIVE" if t["is_active"] else "❌ DEAD"
        if t["name"] in (restarted_timers or []):
            status += " (RESTARTED)"
        lines.append(f"  {status:25} | {t['name']}")
        if t["last_active"]:
            age = now - t["last_active"]
            # NOTE: this timestamp is ActiveEnterTimestampMonotonic — when
            # the TIMER UNIT became active (i.e. when systemd loaded it,
            # normally at boot), not when it last fired. Labelling it
            # "Last trigger" was misleading: it reported "402.6h ago" for
            # a timer that had fired minutes earlier, which reads as dead.
            lines.append(f"      Timer active since {t['last_active'].strftime('%H:%M')} UTC ({age.total_seconds()/3600:.1f}h ago)")

    if services:
        lines.append("\n🔍 SERVICES (stuck check):")
        for s in services:
            if s["is_stuck"]:
                status = "❌ STUCK"
            else:
                status = "✅ OK"
            if s["name"] in (restarted_services or []):
                status += " (RESTARTED)"
            lines.append(f"  {status:25} | {s['name']}")
            lines.append(f"      {s['reason']}")

    if failed_units is not None:
        lines.append("\n💥 FAILED UNITS (exited non-zero — invisible to both checks above):")
        if failed_units:
            for u in failed_units:
                status = "❌ FAILED"
                if u["name"] in (recovered_units or []):
                    status += " (RE-RUNNING)"
                lines.append(f"  {status:25} | {u['name']}")
                if u["name"] not in AUTO_RECOVER_FAILED:
                    lines.append("      not auto-restarted — inspect manually")
        else:
            lines.append("  ✅ none")

    if restarted_timers or restarted_services or recovered_units:
        lines.append("")
        if restarted_timers:
            lines.append(f"Auto-restarted timers: {', '.join(restarted_timers)}")
        if restarted_services:
            lines.append(f"Auto-restarted services: {', '.join(restarted_services)}")
        if recovered_units:
            lines.append(f"Recovered failed units: {', '.join(recovered_units)}")

    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="XYZO Timer & Service Watchdog")
    parser.add_argument("--fix", action="store_true", help="Auto-restart dead/hung services")
    parser.add_argument("--cron", action="store_true", help="Cron mode: check and email on issues")
    args = parser.parse_args()

    timers = check_all_timers()
    services = check_all_services()
    failed_units = check_failed_units()

    dead_timers = [t for t in timers if not t["is_active"]]
    stuck_services = [s for s in services if s["is_stuck"]]

    restarted_timers = []
    restarted_services = []
    recovered_units = []

    if args.fix and (dead_timers or stuck_services):
        restarted_timers, restarted_services = auto_restart_dead(dead_timers, stuck_services)
    if args.fix and failed_units:
        recovered_units = recover_failed(failed_units)

    print(format_report(timers, services, restarted_timers, restarted_services,
                        failed_units, recovered_units))

    # After a --fix recovery the state has moved on, so re-check rather
    # than trust the snapshot taken on arrival. Deliberately NO
    # "exclude recovered" filter: a unit whose restart succeeded has
    # dropped out of the failed list on its own, while one that failed
    # again immediately must still be reported as an issue.
    still_failed = check_failed_units() if args.fix else failed_units

    issues = len(dead_timers) + len(stuck_services) + len(still_failed)
    if issues > 0:
        print(f"\n⚠️  {issues} issue(s) found!", file=sys.stderr)
        if args.cron:
            pass  # Would send email in production
        sys.exit(1)
    else:
        print("\n✅ All systems healthy")
        sys.exit(0)
