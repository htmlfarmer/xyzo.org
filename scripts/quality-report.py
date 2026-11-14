#!/usr/bin/env python3
"""quality-report.py — Generate quality trend reports from track-quality.sh history.

Usage:
    python3 scripts/quality-report.py                 # last 30 runs
    python3 scripts/quality-report.py --days 7        # last 7 days
    python3 scripts/quality-report.py --trend         # trend analysis
    python3 scripts/quality-report.py --json          # machine-readable output
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HISTORY_FILE = Path(os.environ.get(
    "XYZO_WORKDIR", Path(__file__).resolve().parent.parent
)) / "data" / "quality" / "history.jsonl"
WORKDIR = Path(os.environ.get(
    "XYZO_WORKDIR", Path(__file__).resolve().parent.parent
))


def load_history(days: int | None = None) -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    entries = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    for line in HISTORY_FILE.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if cutoff:
            ts = entry.get("ts", "")
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if dt < cutoff:
                    continue
            except (ValueError, TypeError):
                continue
        entries.append(entry)
    return entries


def suite_summary(entries: list[dict]) -> dict:
    by_suite = defaultdict(lambda: {"passed": 0, "failed": 0, "runs": 0, "durations": []})
    for e in entries:
        s = by_suite[e["suite"]]
        s["passed"] += e.get("passed", 0)
        s["failed"] += e.get("failed", 0)
        s["runs"] += 1
        s["durations"].append(e.get("duration_ms", 0))
    result = {}
    for suite, data in by_suite.items():
        total = data["passed"] + data["failed"]
        durs = data["durations"]
        result[suite] = {
            "total_passed": data["passed"],
            "total_failed": data["failed"],
            "runs": data["runs"],
            "pass_rate": round(data["passed"] / max(total, 1) * 100, 1),
            "avg_duration_ms": round(sum(durs) / max(len(durs), 1)),
            "max_duration_ms": max(durs) if durs else 0,
        }
    return result


def trend_analysis(entries: list[dict]) -> dict:
    """Compare first half vs second half of entries to detect trends."""
    if len(entries) < 4:
        return {"insufficient_data": True}

    mid = len(entries) // 2
    first_half = entries[:mid]
    second_half = entries[mid:]

    first_fails = sum(e.get("failed", 0) for e in first_half)
    second_fails = sum(e.get("failed", 0) for e in second_half)
    first_dur = sum(e.get("duration_ms", 0) for e in first_half) / max(len(first_half), 1)
    second_dur = sum(e.get("duration_ms", 0) for e in second_half) / max(len(second_half), 1)

    fail_delta = second_fails - first_fails
    dur_delta = second_dur - first_dur

    return {
        "first_half_runs": len(first_half),
        "second_half_runs": len(second_half),
        "first_half_failures": first_fails,
        "second_half_failures": second_fails,
        "failure_trend": "improving" if fail_delta < 0 else "regressing" if fail_delta > 0 else "stable",
        "failure_delta": fail_delta,
        "avg_duration_first": round(first_dur),
        "avg_duration_second": round(second_dur),
        "duration_trend": "improving" if dur_delta < 0 else "regressing" if dur_delta > 0 else "stable",
        "duration_delta_ms": round(dur_delta),
    }


def git_health() -> dict:
    """Quick repo health signals."""
    workdir = WORKDIR
    result = {}
    try:
        import subprocess
        # Uncommitted changes
        r = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True, cwd=workdir)
        uncommitted = len([l for l in r.stdout.strip().splitlines() if l.strip()])
        result["uncommitted_files"] = uncommitted
        # Last commit age
        r = subprocess.run(["git", "log", "-1", "--format=%ci"], capture_output=True, text=True, cwd=workdir)
        if r.stdout.strip():
            last_commit = datetime.fromisoformat(r.stdout.strip())
            age_hours = (datetime.now(timezone.utc) - last_commit.replace(tzinfo=timezone.utc)).total_seconds() / 3600
            result["last_commit_hours_ago"] = round(age_hours, 1)
        # Branch
        r = subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True, cwd=workdir)
        result["branch"] = r.stdout.strip()
    except Exception:
        pass
    return result


def code_stats() -> dict:
    """Count lines of code across main files."""
    workdir = WORKDIR
    stats = {}
    targets = {
        "app.js": workdir / "public_html" / "app.js",
        "styles.css": workdir / "public_html" / "styles.css",
        "article_priority.py": workdir / "worker" / "article_priority.py",
        "nn_infer.py": workdir / "worker" / "nn_infer.py",
        "nn_features.py": workdir / "worker" / "nn_features.py",
    }
    total = 0
    for name, path in targets.items():
        if path.exists():
            lines = len(path.read_text().splitlines())
            stats[name] = lines
            total += lines
    stats["total_tracked"] = total
    return stats


def print_report(entries: list[dict], include_trend: bool = False):
    if not entries:
        print("No quality history found. Run track-quality.sh first.")
        return

    summaries = suite_summary(entries)
    git = git_health()
    code = code_stats()

    print()
    print("═══════════════════════════════════════════════════════════")
    print("  XYZO Code Quality Report")
    print("═══════════════════════════════════════════════════════════")
    print()

    # Time range
    ts_list = [e.get("ts", "") for e in entries if e.get("ts")]
    if ts_list:
        print(f"  Period: {ts_list[0][:19]} → {ts_list[-1][:19]}")
        print(f"  Total runs: {len(entries)}")
    print()

    # Suite breakdown
    print("  ┌─────────────────┬──────┬──────┬────────┬──────────┐")
    print("  │ Suite           │ Pass │ Fail │ Rate   │ Avg ms   │")
    print("  ├─────────────────┼──────┼──────┼────────┼──────────┤")
    for suite, data in sorted(summaries.items()):
        name = suite[:15].ljust(15)
        rate_color = "\033[32m" if data["pass_rate"] >= 90 else "\033[33m" if data["pass_rate"] >= 70 else "\033[31m"
        print(f"  │ {name} │ {str(data['total_passed']).rjust(4)} │ {str(data['total_failed']).rjust(4)} │ {rate_color}{data['pass_rate']:5.1f}%\033[0m │ {str(data['avg_duration_ms']).rjust(8)} │")
    print("  └─────────────────┴──────┴──────┴────────┴──────────┘")
    print()

    # Git health
    if git:
        print("  Git Health:")
        if "branch" in git:
            print(f"    Branch: {git['branch']}")
        if "uncommitted_files" in git:
            uc = git["uncommitted_files"]
            color = "\033[32m" if uc == 0 else "\033[33m" if uc < 5 else "\033[31m"
            print(f"    Uncommitted files: {color}{uc}\033[0m")
        if "last_commit_hours_ago" in git:
            age = git["last_commit_hours_ago"]
            color = "\033[32m" if age < 24 else "\033[33m" if age < 168 else "\033[31m"
            print(f"    Last commit: {color}{age:.1f}h ago\033[0m")
        print()

    # Code stats
    if code:
        print("  Codebase Size:")
        for name, lines in sorted(code.items()):
            if name == "total_tracked":
                continue
            print(f"    {name}: {lines:,} lines")
        if "total_tracked" in code:
            print(f"    ─────────────────")
            print(f"    Total tracked: {code['total_tracked']:,} lines")
        print()

    # Trend
    if include_trend:
        trend = trend_analysis(entries)
        if not trend.get("insufficient_data"):
            print("  Trend Analysis (first half vs second half):")
            ft = trend["failure_trend"]
            fc = "\033[32m" if ft == "improving" else "\033[31m" if ft == "regressing" else "\033[33m"
            print(f"    Failures: {fc}{ft}\033[0m ({trend['failure_delta']:+d} failures)")
            dt = trend["duration_trend"]
            dc = "\033[32m" if dt == "improving" else "\033[31m" if dt == "regressing" else "\033[33m"
            print(f"    Duration: {dc}{dt}\033[0m ({trend['duration_delta_ms']:+d}ms)")
            print()

    print("═══════════════════════════════════════════════════════════")


def main():
    parser = argparse.ArgumentParser(description="Quality report from track-quality.sh history")
    parser.add_argument("--days", type=int, help="Only include last N days")
    parser.add_argument("--trend", action="store_true", help="Include trend analysis")
    parser.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    args = parser.parse_args()

    entries = load_history(days=args.days)

    if args.json:
        output = {
            "run_count": len(entries),
            "suites": suite_summary(entries),
            "git": git_health(),
            "code": code_stats(),
        }
        if args.trend:
            output["trend"] = trend_analysis(entries)
        print(json.dumps(output, indent=2))
    else:
        print_report(entries, include_trend=args.trend)


if __name__ == "__main__":
    main()
