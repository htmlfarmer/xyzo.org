"""Mobile Testing — Playwright device emulation + matrix testing for xyzo.org.

Tests XYZO workflows across a device matrix:
  Desktop (1920x1080 Chrome)
  Laptop (1440x900 Chrome)
  Tablet (1024x768 Chrome)
  iPhone (390x844 WebKit)
  Android (412x915 Chromium)
  Small Android (360x800 Chromium)

Usage:
    matrix = MobileTestMatrix("http://xyzo.org")
    results = matrix.run_matrix(["map_load", "pin_click", "filter_buttons"])
    print(matrix.summary(results))
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from playwright.sync_api import Page, BrowserContext

TRACE_DIR = Path("/var/www/vhosts/xyzo.org/data/playwright_traces")
TRACE_DIR.mkdir(parents=True, exist_ok=True)


DEVICE_MATRIX = [
    {"name": "Desktop 1920", "viewport": {"width": 1920, "height": 1080}, "device_scale_factor": 1, "browser": "chromium", "user_agent": None},
    {"name": "Laptop 1440", "viewport": {"width": 1440, "height": 900}, "device_scale_factor": 1, "browser": "chromium", "user_agent": None},
    {"name": "Tablet 1024", "viewport": {"width": 1024, "height": 768}, "device_scale_factor": 1, "browser": "chromium", "user_agent": None},
    {"name": "iPhone 14 Pro", "viewport": {"width": 393, "height": 852}, "device_scale_factor": 3, "browser": "webkit", "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15"},
    {"name": "Android Pixel 6", "viewport": {"width": 412, "height": 915}, "device_scale_factor": 2.625, "browser": "chromium", "user_agent": None},
    {"name": "Small Android 360", "viewport": {"width": 360, "height": 800}, "device_scale_factor": 2, "browser": "chromium", "user_agent": None},
]


@dataclass
class DeviceResult:
    device_name: str
    viewport: dict
    success: bool
    error: str | None
    pin_count: int | None
    map_visible: bool
    console_errors: int
    network_errors: int
    screenshot_path: str | None
    load_time_ms: float | None
    map_state: dict | None


@dataclass
class MobileTestMatrix:
    base_url: str = "http://xyzo.org"
    devices: list[dict] = None

    def __post_init__(self):
        from playwright.sync_api import sync_playwright
        self.devices = self.devices or DEVICE_MATRIX
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )

    def __del__(self):
        if hasattr(self, '_browser') and self._browser:
            self._browser.close()
        if hasattr(self, '_pw') and self._pw:
            self._pw.stop()

    def _get_context(self, device: dict) -> BrowserContext:
        return self._browser.new_context(
            viewport=device["viewport"],
            device_scale_factor=device.get("device_scale_factor", 1),
            user_agent=device.get("user_agent"),
        )

    def test_map_load(
        self,
        page: Page,
        lat: float = -6.2,
        lng: float = 106.8,
        zoom: int = 8,
    ) -> tuple[int, bool, dict]:
        """Test that the map loads and shows pins."""
        url = f"{self.base_url}/#{lat},{lng},{zoom}"
        page.goto(url, wait_until="networkidle", timeout=30000)
        time.sleep(2)

        pin_count = 0
        try:
            pin_count = page.evaluate("""
                () => {
                    if (window.pinMarkers) return window.pinMarkers.size;
                    if (window.canvasRenderer && window.canvasRenderer._pins) return window.canvasRenderer._pins.length;
                    return 0;
                }
            """)
        except Exception:
            pass

        map_visible = False
        try:
            map_visible = page.locator(".leaflet-container").is_visible(timeout=2000)
        except Exception:
            pass

        map_state = {}
        try:
            map_state = page.evaluate("""
                () => {
                    if (typeof map === 'undefined' || !map) return {};
                    const c = map.getCenter();
                    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
                }
            """)
        except Exception:
            pass

        return pin_count, map_visible, map_state

    def compare_desktop_mobile_pins(
        self,
        lat: float,
        lng: float,
        zoom: int,
    ) -> dict:
        """Compare desktop vs mobile pin fetching for the same coordinates."""
        results = {}

        for device in self.devices:
            name = device["name"]
            is_mobile = device["viewport"]["width"] < 500

            context = self._get_context(device)
            page = context.new_page()

            t0 = time.monotonic()
            pin_count, map_visible, map_state = self.test_map_load(page, lat, lng, zoom)
            load_time = (time.monotonic() - t0) * 1000

            console_errors = 0
            network_errors = 0

            try:
                ss = page.screenshot()
                screenshot_path = str(TRACE_DIR / f"mobile_{name.replace(' ', '_')}_{int(time.time())}.png")
                Path(screenshot_path).write_bytes(ss)
            except Exception:
                screenshot_path = None

            results[name] = DeviceResult(
                device_name=name,
                viewport=device["viewport"],
                success=map_visible and pin_count is not None,
                error=None,
                pin_count=pin_count,
                map_visible=map_visible,
                console_errors=console_errors,
                network_errors=network_errors,
                screenshot_path=screenshot_path,
                load_time_ms=load_time,
                map_state=map_state,
            )

            context.close()

        return results

    def check_mobile_pins_bug(
        self,
        lat: float = -6.2,
        lng: float = 106.8,
        zoom: int = 8,
    ) -> dict:
        """Specifically check for the mobile pin display bug."""
        desktop_state = None
        mobile_state = None

        for device in self.devices:
            if device["name"] == "Desktop 1920":
                context = self._get_context(device)
                page = context.new_page()
                _, _, desktop_state = self.test_map_load(page, lat, lng, zoom)
                context.close()

            if device["name"] == "iPhone 14 Pro":
                context = self._get_context(device)
                page = context.new_page()
                _, _, mobile_state = self.test_map_load(page, lat, lng, zoom)
                context.close()

        return {
            "desktop_state": desktop_state,
            "mobile_state": mobile_state,
            "desktop_pins": desktop_state.get("pin_count") if isinstance(desktop_state, dict) else None,
            "mobile_pins": mobile_state.get("pin_count") if isinstance(mobile_state, dict) else None,
            "zoom_match": desktop_state.get("zoom") == mobile_state.get("zoom") if isinstance(desktop_state, dict) and isinstance(mobile_state, dict) else None,
        }

    def run_workflow(
        self,
        workflow_fn: Callable[[Page, str], bool],
        workflow_name: str = "workflow",
    ) -> dict[str, DeviceResult]:
        """Run a custom workflow against the full device matrix."""
        results = {}

        for device in self.devices:
            name = device["name"]
            context = self._get_context(device)
            page = context.new_page()
            ss_path = None

            t0 = time.monotonic()
            success = False
            error = None

            try:
                success = workflow_fn(page, name)
            except Exception as e:
                error = str(e)

            load_time = (time.monotonic() - t0) * 1000

            try:
                ss = page.screenshot()
                ss_path = str(TRACE_DIR / f"workflow_{workflow_name}_{name.replace(' ', '_')}.png")
                Path(ss_path).write_bytes(ss)
            except Exception:
                pass

            results[name] = DeviceResult(
                device_name=name,
                viewport=device["viewport"],
                success=success,
                error=error,
                pin_count=None,
                map_visible=False,
                console_errors=0,
                network_errors=0,
                screenshot_path=ss_path,
                load_time_ms=load_time,
                map_state=None,
            )

            context.close()

        return results

    def summary(self, results: dict[str, DeviceResult]) -> str:
        lines = [
            "╔══════════════════════════════════════════════════════════╗",
            "║           XYZO MOBILE TEST MATRIX RESULTS             ║",
            "╚══════════════════════════════════════════════════════════╝",
        ]

        for name, result in results.items():
            status = "✓" if result.success else "✗"
            lines.append(f"  {status}  {name:<20} {result.viewport['width']}x{result.viewport['height']}")
            if result.pin_count is not None:
                lines.append(f"      pins: {result.pin_count}")
            if result.load_time_ms:
                lines.append(f"      load: {result.load_time_ms:.0f}ms")
            if result.error:
                lines.append(f"      error: {result.error[:60]}")
            if result.screenshot_path:
                lines.append(f"      screenshot: {result.screenshot_path}")

        successes = sum(1 for r in results.values() if r.success)
        lines.append(f"\n  Summary: {successes}/{len(results)} devices passed")

        return "\n".join(lines)


def test_map_load_workflow(page: Page, device_name: str) -> bool:
    """Standard map load test workflow."""
    page.goto("http://xyzo.org/#-6.2,106.8,8", wait_until="networkidle", timeout=30000)
    time.sleep(2)
    visible = page.locator(".leaflet-container").is_visible(timeout=5000)
    return visible


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="XYZO Mobile Testing")
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--lat", type=float, default=-6.2)
    parser.add_argument("--lng", type=float, default=106.8)
    parser.add_argument("--zoom", type=int, default=8)
    parser.add_argument("--check-bug", action="store_true")
    args = parser.parse_args()

    matrix = MobileTestMatrix(base_url=args.url)

    if args.check_bug:
        result = matrix.check_mobile_pins_bug(args.lat, args.lng, args.zoom)
        print(json.dumps(result, indent=2, default=str))
    else:
        results = matrix.run_workflow(test_map_load_workflow, "map_load")
        print(matrix.summary(results))
