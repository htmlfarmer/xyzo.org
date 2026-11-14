#!/usr/bin/env python3
"""xyzo-debug — unified debugging CLI for xyzo.org.

Comprehensive diagnostic tools for browser, mobile, network, database, and UI debugging.

Usage:
    xyzo-debug ui                          # UI health scan
    xyzo-debug mobile                      # Mobile test matrix
    xyzo-debug mobile --check-bug          # Check mobile pin bug
    xyzo-debug pins --bbox 105,-7,107,-5  # Pin count diagnostic
    xyzo-debug click --selector "button"   # Click investigation
    xyzo-debug network                    # Network throttle tests
    xyzo-debug bug --description "..."     # Generate bug packet
    xyzo-debug screenshot                  # Take screenshot
    xyzo-debug health                     # Full system health
    xyzo-debug compare                    # Compare desktop vs mobile
    xyzo-debug rapid                      # Rapid interaction test

Examples:
    xyzo-debug mobile --lat -6.2 --lng 106.8 --zoom 8
    xyzo-debug pins --bbox 105,-7,107,-5 --compare
    xyzo-debug click --url http://xyzo.org --selector "#reload-btn"
    xyzo-debug bug --description "Load More button broken" --url http://xyzo.org
    xyzo-debug screenshot --url "http://xyzo.org/#-6.2,106.8,8"
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from .click_investigator import ClickInvestigator
from .ui_health_scanner import UIHealthScanner
from .bug_packet import BugPacket
from .playwright_diagnostics import PlaywrightDiagnostics
from .mobile_testing import MobileTestMatrix
from .visual_regression import VisualRegression
from .network_throttle import NetworkThrottle
from .db_diagnostics import DBDiagnostics


def cmd_ui(args):
    """UI health scanner."""
    scanner = UIHealthScanner(base_url=args.url)
    with PlaywrightDiagnostics(base_url=args.url, headless=True) as diag:
        page = diag._context.new_page()
        page.set_viewport_size({"width": args.width, "height": args.height})
        page.goto(args.url, wait_until="networkidle", timeout=30000)
        time.sleep(1)
        report = scanner.scan_all(page)
    print(scanner.summary(report))
    if args.json:
        from dataclasses import asdict
        print(json.dumps(asdict(report), indent=2, default=str))


def cmd_mobile(args):
    """Mobile test matrix."""
    matrix = MobileTestMatrix(base_url=args.url)

    if args.check_bug:
        result = matrix.check_mobile_pins_bug(args.lat, args.lng, args.zoom)
        print(json.dumps(result, indent=2, default=str))
    else:
        results = matrix.compare_desktop_mobile_pins(args.lat, args.lng, args.zoom)
        print(matrix.summary(results))
        if args.json:
            from dataclasses import asdict
            print(json.dumps({k: asdict(v) for k, v in results.items()}, indent=2, default=str))


def cmd_pins(args):
    """Pin count diagnostic — trace DB → API → Browser."""
    diag = DBDiagnostics()

    if args.compare:
        result = diag.compare_desktop_mobile(args.bbox)
        print(json.dumps(result, indent=2))
    elif args.pagination_check:
        result = diag.find_pagination_bug(args.bbox)
        print(json.dumps(result, indent=2))
    elif args.explain:
        result = diag.explain_pin_query(args.bbox)
        print(json.dumps(result, indent=2))
    else:
        result = diag.trace_pins_api(args.bbox, args.limit)
        print(diag.print_trace(result))


def cmd_click(args):
    """Click investigation."""
    inv = ClickInvestigator(base_url=args.url)
    from .playwright_diagnostics import PlaywrightDiagnostics

    with PlaywrightDiagnostics(base_url=args.url) as diag:
        page = diag._context.new_page()
        page.goto(args.url, wait_until="networkidle", timeout=30000)
        time.sleep(1)
        result = inv.investigate(page, args.selector)
    print(inv.summary(result))
    if args.json:
        from dataclasses import asdict
        print(json.dumps(asdict(result), indent=2, default=str))


def cmd_network(args):
    """Network throttle tests."""
    nt = NetworkThrottle(base_url=args.url)

    if args.condition and args.condition != "all":
        from .playwright_diagnostics import PlaywrightDiagnostics
        with PlaywrightDiagnostics(base_url=args.url) as diag:
            page = diag._context.new_page()
            page.goto(args.url, wait_until="networkidle", timeout=30000)
            result = nt.test_condition(page, args.condition)
            print(json.dumps(result, indent=2, default=str))
    else:
        results = nt.test_all_conditions()
        print(nt.summary(results))
        if args.json:
            from dataclasses import asdict
            print(json.dumps({k: asdict(v) for k, v in results.items()}, indent=2, default=str))


def cmd_bug(args):
    """Generate bug packet."""
    from .playwright_diagnostics import PlaywrightDiagnostics

    with PlaywrightDiagnostics(base_url=args.url) as diag:
        page = diag._context.new_page()
        page.set_viewport_size({"width": 1920, "height": 1080})
        page.goto(args.url, wait_until="networkidle", timeout=30000)
        time.sleep(1)
        packet = BugPacket.capture(page, args.description, args.action, args.element)
    print(packet.summary())
    if args.output:
        packet.save(args.output)
        print(f"\nSaved to: {args.output}")
    if args.json:
        from dataclasses import asdict
        print(json.dumps(asdict(packet), indent=2, default=str))


def cmd_screenshot(args):
    """Take screenshot."""
    vr = VisualRegression(base_url=args.url)
    path = vr.capture_baseline(args.name, args.url, {"width": args.width, "height": args.height})
    print(f"Screenshot saved: {path}")


def cmd_health(args):
    """Full system health check."""
    from ..quick_checks import (
        check_db_size, check_source_health, check_article_health,
        check_location_health, check_event_health, check_nn_pipeline,
        check_worker_liveness,
    )

    print("══ XYZO Full System Health ══")
    print()

    db = check_db_size()
    print(f"  DB Articles: {db['articles']:,}")
    print(f"  DB Events:   {db['events']:,}")
    print(f"  DB Sources:  {db['total_sources']:,} (active: {db['active_sources']:,})")

    sources = check_source_health()
    dist = sources["distribution"]
    print(f"  Sources OK:  {dist.get('perfect', 0) + dist.get('low_errors', 0):,}")
    print(f"  Sources warn: {dist.get('medium_errors', 0):,}")
    print(f"  Sources fail: {dist.get('high_errors', 0):,}")

    articles = check_article_health()
    stats = articles["stats"]
    print(f"  Articles 24h: {stats.get('last_24h', 0):,}")
    print(f"  Empty titles: {stats.get('empty_titles', 0):,}")

    events = check_event_health()
    ev = events["stats"]
    print(f"  Events 24h: {ev.get('last_24h', 0):,}")

    nn = check_nn_pipeline()
    geo = nn["geolocation_labels"]
    has_data = geo.get("geo_has_data", 0)
    with_labels = geo.get("geo_with_labels", 0)
    geo_status = "✓" if has_data > 0 else "✗ BROKEN"
    print(f"  Geolocation NN: {geo_status} ({with_labels} training samples with coordinates)")

    print()

    if args.verbose:
        # Try the URL; fall back to localhost if unreachable
        ui_url = args.url
        try:
            import httpx
            r = httpx.get(f"{ui_url}/", timeout=3.0)
            r.raise_for_status()
        except Exception:
            ui_url = "http://localhost:3008"
            print(f"  (URL unreachable, using {ui_url} for UI checks)")

        print("══ UI Health (1920x1080) ══")
        try:
            scanner = UIHealthScanner(base_url=ui_url)
            with PlaywrightDiagnostics(base_url=ui_url, headless=True) as diag:
                page = diag._context.new_page()
                page.set_viewport_size({"width": 1920, "height": 1080})
                page.goto(ui_url, wait_until="networkidle", timeout=30000)
                time.sleep(1)
                report = scanner.scan_all(page)
            print(scanner.summary(report))
        except Exception as e:
            print(f"  UI scan failed: {e}")


def cmd_compare(args):
    """Compare desktop vs mobile for a specific location."""
    matrix = MobileTestMatrix(base_url=args.url)
    result = matrix.check_mobile_pins_bug(args.lat, args.lng, args.zoom)
    print(json.dumps(result, indent=2, default=str))


def cmd_rapid(args):
    """Rapid interaction test."""
    nt = NetworkThrottle(base_url=args.url)

    interactions = []
    if args.zoom:
        def zoom_fn(page):
            for _ in range(args.count):
                page.keyboard.press("+")
                time.sleep(0.05)
        interactions.append(zoom_fn)
    if args.pan:
        def pan_fn(page):
            for _ in range(args.count):
                page.keyboard.press("ArrowRight")
                time.sleep(0.05)
        interactions.append(pan_fn)
    if args.click:
        def click_fn(page):
            page.mouse.click(960, 540)
            time.sleep(0.1)
        interactions.append(click_fn)

    if not interactions:
        print("No interactions specified. Use --zoom, --pan, or --click")
        return

    result = nt.test_rapid_interaction(interactions, args.network)
    print(json.dumps(result, indent=2, default=str))


def main():
    parser = argparse.ArgumentParser(
        prog="xyzo-debug",
        description="XYZO Debugging CLI — comprehensive browser, mobile, network, and DB diagnostics",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ui = sub.add_parser("ui", help="UI health scanner")
    p_ui.add_argument("--url", default="http://xyzo.org")
    p_ui.add_argument("--width", type=int, default=1920)
    p_ui.add_argument("--height", type=int, default=1080)
    p_ui.add_argument("--json", action="store_true")
    p_ui.set_defaults(fn=cmd_ui)

    p_mobile = sub.add_parser("mobile", help="Mobile test matrix")
    p_mobile.add_argument("--url", default="http://xyzo.org")
    p_mobile.add_argument("--lat", type=float, default=-6.2)
    p_mobile.add_argument("--lng", type=float, default=106.8)
    p_mobile.add_argument("--zoom", type=int, default=8)
    p_mobile.add_argument("--check-bug", action="store_true")
    p_mobile.add_argument("--json", action="store_true")
    p_mobile.set_defaults(fn=cmd_mobile)

    p_pins = sub.add_parser("pins", help="Pin count diagnostic (DB → API → Browser)")
    p_pins.add_argument("--bbox", default="105.0,-7.0,107.0,-5.0")
    p_pins.add_argument("--limit", type=int, default=5000)
    p_pins.add_argument("--compare", action="store_true")
    p_pins.add_argument("--pagination-check", action="store_true")
    p_pins.add_argument("--explain", action="store_true")
    p_pins.set_defaults(fn=cmd_pins)

    p_click = sub.add_parser("click", help="Click investigation")
    p_click.add_argument("--url", default="http://xyzo.org")
    p_click.add_argument("--selector", required=True)
    p_click.add_argument("--json", action="store_true")
    p_click.set_defaults(fn=cmd_click)

    p_net = sub.add_parser("network", help="Network throttle tests")
    p_net.add_argument("--url", default="http://xyzo.org")
    p_net.add_argument("--condition", default="all")
    p_net.add_argument("--json", action="store_true")
    p_net.set_defaults(fn=cmd_network)

    p_bug = sub.add_parser("bug", help="Generate bug packet")
    p_bug.add_argument("--description", required=True)
    p_bug.add_argument("--url", default="http://xyzo.org")
    p_bug.add_argument("--action", default="")
    p_bug.add_argument("--element", default="")
    p_bug.add_argument("--output", default="")
    p_bug.add_argument("--json", action="store_true")
    p_bug.set_defaults(fn=cmd_bug)

    p_ss = sub.add_parser("screenshot", help="Take screenshot")
    p_ss.add_argument("--url", default="http://xyzo.org")
    p_ss.add_argument("--name", default="screenshot")
    p_ss.add_argument("--width", type=int, default=1920)
    p_ss.add_argument("--height", type=int, default=1080)
    p_ss.set_defaults(fn=cmd_screenshot)

    p_health = sub.add_parser("health", help="Full system health check")
    p_health.add_argument("--url", default="http://xyzo.org")
    p_health.add_argument("--verbose", action="store_true")
    p_health.set_defaults(fn=cmd_health)

    p_compare = sub.add_parser("compare", help="Desktop vs mobile comparison")
    p_compare.add_argument("--url", default="http://xyzo.org")
    p_compare.add_argument("--lat", type=float, default=-6.2)
    p_compare.add_argument("--lng", type=float, default=106.8)
    p_compare.add_argument("--zoom", type=int, default=8)
    p_compare.set_defaults(fn=cmd_compare)

    p_rapid = sub.add_parser("rapid", help="Rapid interaction test (race conditions)")
    p_rapid.add_argument("--url", default="http://xyzo.org")
    p_rapid.add_argument("--network", default="slow_4g")
    p_rapid.add_argument("--zoom", action="store_true")
    p_rapid.add_argument("--pan", action="store_true")
    p_rapid.add_argument("--click", action="store_true")
    p_rapid.add_argument("--count", type=int, default=10)
    p_rapid.set_defaults(fn=cmd_rapid)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
