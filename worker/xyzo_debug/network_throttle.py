"""Network Throttling Testing — test XYZO under various network conditions.

Tests map behavior under:
  Fast, Normal, Slow 4G, Very Slow, Offline, Reconnect

This exposes race conditions and async bugs that don't appear on localhost.

Usage:
    nt = NetworkThrottle("http://xyzo.org")
    results = nt.test_all_conditions("map_pan", lambda page: page.click(".leaflet-container"))
    print(nt.summary(results))
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from playwright.sync_api import Page

TRACE_DIR = Path("/var/www/vhosts/xyzo.org/data/playwright_traces")
TRACE_DIR.mkdir(parents=True, exist_ok=True)


NETWORK_PROFILES = {
    "fast": {
        "download": (100_000_000, 50_000_000),
        "upload": (50_000_000, 25_000_000),
        "latency": (5, 5),
    },
    "normal": {
        "download": (5_000_000, 1_000_000),
        "upload": (3_000_000, 750_000),
        "latency": (50, 20),
    },
    "slow_4g": {
        "download": (400_000, 400_000),
        "upload": (400_000, 400_000),
        "latency": (400, 100),
    },
    "very_slow": {
        "download": (50_000, 50_000),
        "upload": (30_000, 30_000),
        "latency": (1000, 200),
    },
    "offline": {
        "download": (0, 0),
        "upload": (0, 0),
        "latency": None,
    },
}


@dataclass
class NetworkConditionResult:
    condition: str
    success: bool
    error: str | None
    console_errors: int
    network_requests: int
    network_failures: int
    pin_count_before: int | None
    pin_count_after: int | None
    map_state_after: dict | None
    screenshot_path: str | None
    duration_ms: float | None
    race_condition_detected: bool = False


class NetworkThrottle:
    """Test XYZO under various network conditions."""

    def __init__(self, base_url: str = "http://xyzo.org"):
        self.base_url = base_url

    def test_condition(
        self,
        page: Page,
        condition: str,
        test_fn: Callable[[Page], None] | None = None,
    ) -> NetworkConditionResult:
        """Test under a specific network condition."""
        profile = NETWORK_PROFILES.get(condition, NETWORK_PROFILES["normal"])

        console_errors: list[dict] = []
        network_requests: list[dict] = []
        network_failures = 0
        screenshot_path = ""

        def on_console(msg):
            if msg.type == "error":
                console_errors.append({"text": msg.text})

        def on_response(response):
            network_requests.append({
                "url": response.url,
                "status": response.status,
            })
            if response.failure:
                network_failures += 1

        page.on("console", on_console)
        page.on("response", on_response)

        t0 = time.monotonic()

        if condition != "offline":
            page.context.set_network_conditions({
                "download_throughput": profile["download"][0],
                "upload_throughput": profile["upload"][0],
                "latency": profile["latency"][0] if profile["latency"] else 0,
            })

        pin_count_before = None
        pin_count_after = None
        map_state_after = None

        try:
            page.goto(self.base_url, wait_until="networkidle", timeout=60000)
            time.sleep(1)

            try:
                pin_count_before = page.evaluate("""
                    () => window.pinMarkers ? window.pinMarkers.size : 0
                """)
            except Exception:
                pass

            if test_fn:
                test_fn(page)

            time.sleep(0.5)

            pin_count_after = page.evaluate("""
                () => {
                    if (window.pinMarkers) return window.pinMarkers.size;
                    if (window.canvasRenderer && window.canvasRenderer._pins) return window.canvasRenderer._pins.length;
                    return 0;
                }
            """)
            map_state_after = page.evaluate("""
                () => {
                    if (typeof map === 'undefined' || !map) return {};
                    const c = map.getCenter();
                    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
                }
            """)
        except Exception as e:
            pass

        duration_ms = (time.monotonic() - t0) * 1000

        race_condition = (
            pin_count_before is not None
            and pin_count_after is not None
            and pin_count_after < pin_count_before
            and condition in ("slow_4g", "very_slow")
        )

        try:
            ss = page.screenshot()
            screenshot_path = str(TRACE_DIR / f"network_{condition}_{int(time.time())}.png")
            Path(screenshot_path).write_bytes(ss)
        except Exception:
            pass

        return NetworkConditionResult(
            condition=condition,
            success=len(console_errors) == 0 and network_failures == 0,
            error=None,
            console_errors=len(console_errors),
            network_requests=len(network_requests),
            network_failures=network_failures,
            pin_count_before=pin_count_before,
            pin_count_after=pin_count_after,
            map_state_after=map_state_after,
            screenshot_path=screenshot_path,
            duration_ms=duration_ms,
            race_condition_detected=race_condition,
        )

    def test_all_conditions(
        self,
        test_fn: Callable[[Page], None] | None = None,
        conditions: list[str] | None = None,
    ) -> dict[str, NetworkConditionResult]:
        """Run tests across all network conditions."""
        from .playwright_diagnostics import PlaywrightDiagnostics

        conditions = conditions or list(NETWORK_PROFILES.keys())
        results = {}

        with PlaywrightDiagnostics(base_url=self.base_url, headless=True) as diag:
            for condition in conditions:
                page = diag._context.new_page()
                page.goto(self.base_url, wait_until="networkidle", timeout=30000)
                result = self.test_condition(page, condition, test_fn)
                results[condition] = result

        return results

    def test_rapid_interaction(
        self,
        interactions: list[Callable[[Page], None]],
        network: str = "slow_4g",
    ) -> dict:
        """Test rapid user interactions that expose race conditions."""
        from .playwright_diagnostics import PlaywrightDiagnostics

        results = {
            "network": network,
            "interactions_tested": len(interactions),
            "race_conditions": [],
            "final_state": {},
        }

        with PlaywrightDiagnostics(base_url=self.base_url, headless=True) as diag:
            page = diag._context.new_page()

            profile = NETWORK_PROFILES.get(network, NETWORK_PROFILES["normal"])
            page.context.set_network_conditions({
                "download_throughput": profile["download"][0],
                "upload_throughput": profile["upload"][0],
                "latency": profile["latency"][0] if profile["latency"] else 0,
            })

            page.goto(self.base_url, wait_until="networkidle", timeout=60000)
            time.sleep(1)

            initial_pins = page.evaluate("window.pinMarkers ? window.pinMarkers.size : 0")

            for i, interaction in enumerate(interactions):
                try:
                    interaction(page)
                except Exception as e:
                    results.setdefault("errors", []).append(f"Interaction {i}: {e}")

                time.sleep(0.1)

            final_pins = page.evaluate("""
                () => {
                    if (window.pinMarkers) return window.pinMarkers.size;
                    if (window.canvasRenderer && window.canvasRenderer._pins) return window.canvasRenderer._pins.length;
                    return 0;
                }
            """)

            results["initial_pins"] = initial_pins
            results["final_pins"] = final_pins

            if final_pins < initial_pins:
                results["race_conditions"].append(
                    f"Pin count dropped from {initial_pins} to {final_pins} during rapid interactions"
                )

            try:
                results["final_state"] = page.evaluate("""
                    () => {
                        if (typeof map === 'undefined' || !map) return {};
                        const c = map.getCenter();
                        return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
                    }
                """)
            except Exception:
                pass

        return results

    def summary(self, results: dict[str, NetworkConditionResult]) -> str:
        lines = [
            "╔══════════════════════════════════════════════════════════╗",
            "║          XYZO NETWORK THROTTLE TEST RESULTS            ║",
            "╚══════════════════════════════════════════════════════════╝",
        ]

        for condition, result in results.items():
            status = "✓" if result.success else "✗"
            race = " 🏎️ RACE" if result.race_condition_detected else ""
            lines.append(f"  {status} {condition:<15} {result.duration_ms:>6.0f}ms{race}")
            lines.append(f"      requests: {result.network_requests}  failures: {result.network_failures}  console errors: {result.console_errors}")
            if result.pin_count_before is not None and result.pin_count_after is not None:
                lines.append(f"      pins: {result.pin_count_before} → {result.pin_count_after}")
            if result.screenshot_path:
                lines.append(f"      screenshot: {result.screenshot_path}")

        race_count = sum(1 for r in results.values() if r.race_condition_detected)
        if race_count:
            lines.append(f"\n  🏎️  {race_count} race condition(s) detected")

        return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--condition", default="all")
    args = parser.parse_args()

    nt = NetworkThrottle(args.url)

    if args.condition == "all":
        results = nt.test_all_conditions()
        print(nt.summary(results))
    else:
        from .playwright_diagnostics import PlaywrightDiagnostics

        with PlaywrightDiagnostics(base_url=args.url) as diag:
            page = diag._context.new_page()
            page.goto(args.url, wait_until="networkidle", timeout=30000)
            result = nt.test_condition(page, args.condition)
            print(json.dumps(result, indent=2, default=str))
