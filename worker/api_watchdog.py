#!/usr/bin/env python3
"""
API Watchdog - Monitors API responsiveness and auto-restarts if hung.

This script is designed to catch the scenario where:
- The API process is running but not responding to HTTP requests
- Endpoints timeout due to high load or database issues
- The server is overwhelmed (load > 8)

Unlike health_monitor.py which watches the fetch worker pipeline, this
watches the API server itself.

Usage:
    python -m worker.api_watchdog              # Check once and report
    python -m worker.api_watchdog --restart    # Auto-restart if hung
    python -m worker.api_watchdog --cron       # For cron: exit 0/1 for healthy/hung
    python -m worker.api_watchdog --verbose    # Detailed output

Crontab entry (every 2 minutes):
    */2 * * * * /var/www/vhosts/xyzo.org/venv/bin/python -m worker.api_watchdog --cron --restart
"""

import argparse
import os
import sys
import subprocess
import time
from datetime import datetime
from typing import Optional

API_BASE = os.environ.get("XYZO_API_URL", "http://127.0.0.1:3008")
TIMEOUT_SEC = 8  # Endpoint timeout - if exceeded, API is considered hung
# The liveness probes get a longer budget: on a loaded box even /api/health
# can queue behind a heavy query, and a false "hung" verdict restarts the API
# (which then takes the whole site down for the length of ExecStartPre).
LIVENESS_TIMEOUT_SEC = 20
# Heavy queries get a generous budget too — they are reported, never fatal.
HEAVY_TIMEOUT_SEC = 30
CONSECUTIVE_FAILURES_FOR_RESTART = 2  # Restart after 2 consecutive failures
_RESTART_COOLDOWN_SEC = 60  # Don't restart more than once per minute


def get_system_load() -> tuple[float, int]:
    """Get 1-minute load average and core count."""
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().split()
            load_1min = float(parts[0])
        with open("/proc/cpuinfo") as f:
            cores = sum(1 for line in f if line.startswith("processor"))
        return load_1min, cores
    except Exception:
        return 0.0, 1


def check_endpoint(path: str, timeout: int = TIMEOUT_SEC) -> dict:
    """Check a single API endpoint. Returns dict with status, response_time, error."""
    import urllib.request
    import urllib.error

    url = f"{API_BASE}{path}"
    start = time.time()

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "xyzo-watchdog/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - start
            body = resp.read(1024)  # Read just first 1KB
            return {
                "ok": resp.status < 400,
                "status": resp.status,
                "response_time": elapsed,
                "error": None,
            }
    except urllib.error.HTTPError as e:
        return {
            "ok": False,
            "status": e.code,
            "response_time": time.time() - start,
            "error": f"HTTP {e.code}",
        }
    except urllib.error.URLError as e:
        return {
            "ok": False,
            "status": 0,
            "response_time": time.time() - start,
            "error": f"URL error: {e.reason}",
        }
    except TimeoutError:
        return {
            "ok": False,
            "status": 0,
            "response_time": timeout,
            "error": f"Timeout after {timeout}s",
        }
    except Exception as e:
        return {
            "ok": False,
            "status": 0,
            "response_time": time.time() - start,
            "error": str(e),
        }


def restart_api() -> bool:
    """Restart the xyzo-api service via systemd. Returns True if successful."""
    try:
        result = subprocess.run(
            ["systemctl", "restart", "xyzo-api"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            print(f"[{datetime.now().isoformat()}] API restart triggered successfully")
            return True
        else:
            print(f"[{datetime.now().isoformat()}] API restart failed: {result.stderr}")
            return False
    except Exception as e:
        print(f"[{datetime.now().isoformat()}] Failed to restart API: {e}")
        return False


def check_and_act(
    do_restart: bool = False,
    verbose: bool = False,
    last_restart_time: Optional[float] = None,
    cooldown_sec: int = _RESTART_COOLDOWN_SEC,
) -> tuple[bool, int, Optional[float]]:
    """
    Check all endpoints and optionally restart if hung.

    Returns: (healthy, failure_count, next_restart_time)
    """
    load, cores = get_system_load()
    load_pct = (load / cores * 100) if cores > 0 else 0

    # (path, may_condemn_the_api, description, timeout)
    #
    # Only the two liveness probes may condemn the API. The heavy queries are
    # measured and reported, but a slow COUNT is a LOAD problem, not a hung
    # process — restarting for it made things worse (the unit validates the
    # API in ExecStartPre, so Caddy answered 502 for the whole window and the
    # browser console filled up with /api/feed/live/stream failures).
    endpoints = [
        ("/api/health", True, "Liveness check", LIVENESS_TIMEOUT_SEC),
        ("/api/version", True, "Version check", LIVENESS_TIMEOUT_SEC),
        ("/api/pins/stats", False, "Pin stats (heavy COUNT)", HEAVY_TIMEOUT_SEC),
        ("/api/pins/map?bbox=-0.1,-0.1,0.1,0.1&limit=1&light=1", False, "Pin map query (regional)", HEAVY_TIMEOUT_SEC),
    ]

    results = []
    failure_count = 0

    for path, may_condemn, desc, timeout in endpoints:
        result = check_endpoint(path, timeout=timeout)
        result["path"] = path
        result["desc"] = desc
        result["lightweight"] = may_condemn
        results.append(result)
        if not result["ok"]:
            failure_count += 1
            if verbose:
                print(f"  FAIL: {path} - {result['error']}")

    # Overall health: ONLY the liveness probes count. A failing heavy
    # endpoint is reported, never acted upon.
    critical = [r for r in results if r["lightweight"]]
    is_hung = any(not r["ok"] for r in critical)

    # High load is a warning, not a failure (system may recover)
    high_load = load_pct > 700  # >7x load on 1 core means trouble

    # Check cooldown
    now = time.time()
    in_cooldown = last_restart_time and (now - last_restart_time) < cooldown_sec

    should_restart = is_hung and do_restart and not in_cooldown

    if should_restart:
        print(f"[{datetime.now().isoformat()}] API HUNG: {failure_count} failures, load={load:.2f} ({load_pct:.0f}% of {cores} cores)")
        for r in results:
            if not r["ok"]:
                print(f"  - {r['path']}: {r['error']} ({r['response_time']:.1f}s)")
        restart_api()
        last_restart_time = now

    return is_hung, failure_count, last_restart_time


def main():
    parser = argparse.ArgumentParser(description="API Watchdog Monitor")
    parser.add_argument("--restart", action="store_true", help="Auto-restart API if hung")
    parser.add_argument(
        "--cron", action="store_true", help="Cron mode: exit 0 if healthy, 1 if hung"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Show detailed output"
    )
    parser.add_argument(
        "--cooldown",
        type=int,
        default=_RESTART_COOLDOWN_SEC,
        help=f"Minimum seconds between restarts (default: {_RESTART_COOLDOWN_SEC})",
    )
    args = parser.parse_args()

    # Check last restart time from a temp file (persists across cron runs)
    state_file = "/tmp/xyzo-api-watchdog.state"
    last_restart_time = None
    try:
        if os.path.exists(state_file):
            last_restart_time = float(open(state_file).read().strip())
    except Exception:
        pass

    load, cores = get_system_load()
    load_pct = (load / cores * 100) if cores > 0 else 0

    is_hung, failure_count, new_last_restart = check_and_act(
        do_restart=args.restart,
        verbose=args.verbose,
        last_restart_time=last_restart_time,
        cooldown_sec=args.cooldown,
    )

    # Update state file
    if new_last_restart:
        try:
            with open(state_file, "w") as f:
                f.write(str(new_last_restart))
        except Exception:
            pass

    if args.verbose or not args.cron:
        print(f"\n=== API Watchdog Report ===")
        print(f"Time: {datetime.now().isoformat()}")
        print(f"System load: {load:.2f} ({load_pct:.0f}% of {cores} cores)")
        print(f"Consecutive failures: {failure_count}")
        print(f"Status: {'HUNG (restart triggered)' if is_hung else 'OK'}")
        print(f"Restart cooldown: {'in effect' if last_restart_time and (time.time() - last_restart_time) < args.cooldown else 'not in effect'}")

    if args.cron:
        sys.exit(1 if is_hung else 0)


if __name__ == "__main__":
    main()
