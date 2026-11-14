"""Playwright browser diagnostics with tracing for xyzo.org.

Provides:
  - Full Playwright setup with Chromium/Firefox/WebKit
  - Automatic trace recording on failures
  - DOM snapshot capture
  - Console/network event capture
  - Screenshot on failure

Usage:
    pw = PlaywrightDiagnostics()
    pw.capture_trace("test_name", lambda page: page.click("button"))
    result = pw.investigate_click_failure("button", "Load More")
    print(result.summary())
"""

from __future__ import annotations

import json
import logging
import os
import time
import traceback
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from playwright.sync_api import (
    Browser, BrowserContext, Page, Playwright,
    sync_playwright, Error, TimeoutError as PWTimeout,
    expect,
)

log = logging.getLogger("xyzo.playwright_diagnostics")

TRACE_DIR = Path("/var/www/vhosts/xyzo.org/data/playwright_traces")
TRACE_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class ConsoleEvent:
    type: str
    text: str
    location: dict
    timestamp: str


@dataclass
class NetworkEvent:
    url: str
    method: str
    status: int | None
    response_body_size: int | None
    duration_ms: float | None
    failed: bool
    timestamp: str


@dataclass
class ClickAttempt:
    selector: str
    success: bool
    error: str | None
    error_type: str | None
    console_events: list[ConsoleEvent]
    network_requests: list[NetworkEvent]
    screenshot_path: str | None
    trace_path: str | None


@dataclass
class DOMSnapshot:
    url: str
    title: str
    viewport: dict
    elements: list[dict]


class PlaywrightDiagnostics:
    """Playwright-powered browser diagnostics for xyzo.org."""

    def __init__(
        self,
        base_url: str = "http://xyzo.org",
        trace_dir: Path = TRACE_DIR,
        headless: bool = True,
    ):
        self.base_url = base_url
        self.trace_dir = trace_dir
        self.headless = headless
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None

    def __enter__(self):
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=self.headless,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        self._context = self._browser.new_context(
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
        )
        return self

    def __exit__(self, *args):
        if self._context:
            self._context.close()
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()

    def _setup_tracing(self, page: Page, name: str):
        trace_path = self.trace_dir / f"{name}_{int(time.time())}.zip"
        page.context.tracing.start(
            screenshots=True,
            snapshots=True,
            sources=True,
        )
        return trace_path

    def _stop_tracing(self, page: Page, trace_path: Path) -> str:
        page.context.tracing.stop(path=str(trace_path))
        return str(trace_path)

    def capture_console(self, page: Page) -> list[ConsoleEvent]:
        events: list[ConsoleEvent] = []
        for msg in page.context.listener.dup():
            pass
        return events

    def navigate_and_capture(
        self,
        url: str,
        wait_until: str = "networkidle",
        timeout: float = 30000,
    ) -> tuple[Page, list[ConsoleEvent], list[NetworkEvent], str]:
        """Navigate to URL and capture all browser state."""
        page = self._context.new_page()
        console_events: list[ConsoleEvent] = []
        network_events: list[NetworkEvent] = []
        screenshot_path = ""

        def on_console(msg):
            console_events.append(ConsoleEvent(
                type=msg.type,
                text=msg.text,
                location=dict(msg.location),
                timestamp=datetime.now(timezone.utc).isoformat(),
            ))

        def on_response(response):
            try:
                size = len(response.body()) if response.status < 400 else 0
            except Exception:
                size = None
            network_events.append(NetworkEvent(
                url=response.url,
                method=response.request.method,
                status=response.status,
                response_body_size=size,
                duration_ms=None,
                failed=response.failure is not None,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ))

        page.on("console", on_console)
        page.on("response", on_response)

        try:
            page.goto(url, wait_until=wait_until, timeout=timeout)
            time.sleep(1)
        except Exception as e:
            log.warning("Navigation failed: %s", e)

        try:
            ss = page.screenshot()
            screenshot_path = str(self.trace_dir / f"screenshot_{int(time.time())}.png")
            Path(screenshot_path).write_bytes(ss)
        except Exception:
            pass

        return page, console_events, network_events, screenshot_path

    def test_element_click(
        self,
        selector: str,
        url: str | None = None,
        expected_change: Callable[[Page], bool] | None = None,
        timeout: float = 5000,
    ) -> ClickAttempt:
        """Attempt to click an element and capture full diagnostic state."""
        target_url = url or self.base_url
        page = self._context.new_page()
        trace_path = self._setup_tracing(page, f"click_{selector.replace(' ', '_')}")
        console_events: list[ConsoleEvent] = []
        network_events: list[NetworkEvent] = []
        screenshot_path = ""

        def on_console(msg):
            console_events.append(ConsoleEvent(
                type=msg.type,
                text=msg.text,
                location=dict(msg.location),
                timestamp=datetime.now(timezone.utc).isoformat(),
            ))

        def on_response(response):
            network_events.append(NetworkEvent(
                url=response.url,
                method=response.request.method,
                status=response.status,
                response_body_size=None,
                duration_ms=None,
                failed=response.failure is not None,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ))

        page.on("console", on_console)
        page.on("response", on_response)

        try:
            page.goto(target_url, wait_until="networkidle", timeout=30000)
        except Exception as e:
            pass

        success = False
        error_msg = None
        error_type = None

        try:
            page.click(selector, timeout=timeout)
            time.sleep(0.5)
            if expected_change and not expected_change(page):
                error_msg = "Click succeeded but expected state change did not occur"
                error_type = "state_mismatch"
            else:
                success = True
        except Error as e:
            error_msg = str(e)
            error_type = e.__class__.__name__
        except Exception as e:
            error_msg = str(e)
            error_type = "UnknownError"

        try:
            ss = page.screenshot()
            screenshot_path = str(self.trace_dir / f"click_fail_{int(time.time())}.png")
            Path(screenshot_path).write_bytes(ss)
        except Exception:
            pass

        trace = self._stop_tracing(page, trace_path)

        return ClickAttempt(
            selector=selector,
            success=success,
            error=error_msg,
            error_type=error_type,
            console_events=console_events,
            network_requests=network_events,
            screenshot_path=screenshot_path,
            trace_path=trace,
        )

    def investigate_map_pin_issue(
        self,
        lat: float,
        lng: float,
        zoom: int,
        device: str | None = None,
    ) -> dict:
        """Investigate why pins don't appear at a given map location."""
        page = self._context.new_page()

        if device:
            devices = self._pw.devices
            if device in devices:
                page = self._context.new_page(viewport=device["viewport"])

        url = f"{self.base_url}/#{lat},{lng},{zoom}"
        trace_path = self._setup_tracing(page, f"map_pin_{lat}_{lng}_{zoom}")

        page.goto(url, wait_until="networkidle", timeout=30000)
        time.sleep(2)

        ss = page.screenshot()
        screenshot_path = str(self.trace_dir / f"map_{lat}_{lng}_{zoom}.png")
        Path(screenshot_path).write_bytes(ss)

        pin_count = 0
        try:
            pin_count = page.evaluate("""
                () => {
                    const pins = window.pinMarkers || new Map();
                    return pins.size;
                }
            """)
        except Exception:
            pass

        canvas_pins = 0
        try:
            canvas_pins = page.evaluate("""
                () => {
                    const cv = window.canvasRenderer;
                    return cv && cv._pins ? cv._pins.length : 0;
                }
            """)
        except Exception:
            pass

        trace = self._stop_tracing(page, trace_path)

        return {
            "url": url,
            "lat": lat,
            "lng": lng,
            "zoom": zoom,
            "device": device,
            "pin_markers_count": pin_count,
            "canvas_pins_count": canvas_pins,
            "screenshot": screenshot_path,
            "trace": trace,
        }

    def capture_dom_snapshot(self, page: Page) -> DOMSnapshot:
        """Capture a full DOM snapshot."""
        snapshot = page.evaluate("""
            () => {
                const els = document.querySelectorAll('[data-xyzo], .leaflet-marker-icon, .cluster-tier');
                return {
                    pinMarkers: window.pinMarkers ? window.pinMarkers.size : 0,
                    canvasRenderer: window.canvasRenderer ? {
                        enabled: window.canvasRenderer._enabled,
                        pinCount: window.canvasRenderer._pins ? window.canvasRenderer._pins.length : 0,
                    } : null,
                    activeModes: window.activeModes ? Array.from(activeModes) : [],
                    mapZoom: window.map ? window.map.getZoom() : null,
                    mapBounds: window.map ? window.map.getBounds().toString() : null,
                };
            }
        """)
        return DOMSnapshot(
            url=page.url,
            title=page.title(),
            viewport={"width": page.viewport_size["width"], "height": page.viewport_size["height"]},
            elements=[snapshot] if snapshot else [],
        )


def run_full_diagnostic(
    description: str,
    test_fn: Callable[[Page], None],
    base_url: str = "http://xyzo.org",
) -> dict:
    """Run a full diagnostic on a test function, capturing traces on failure."""
    with PlaywrightDiagnostics(base_url=base_url) as diag:
        page = diag._context.new_page()
        trace_path = diag._setup_tracing(page, f"full_diag_{description}")

        console_events: list[ConsoleEvent] = []
        network_events: list[NetworkEvent] = []

        def on_console(msg):
            console_events.append(ConsoleEvent(
                type=msg.type,
                text=msg.text,
                location=dict(msg.location),
                timestamp=datetime.now(timezone.utc).isoformat(),
            ))

        page.on("console", on_console)

        screenshot_path = ""
        success = False
        error_detail = None

        try:
            test_fn(page)
            success = True
        except Exception as e:
            error_detail = {
                "type": e.__class__.__name__,
                "message": str(e),
                "trace": traceback.format_exc(),
            }
            try:
                ss = page.screenshot()
                screenshot_path = str(TRACE_DIR / f"FAIL_{description}_{int(time.time())}.png")
                Path(screenshot_path).write_bytes(ss)
            except Exception:
                pass

        trace = diag._stop_tracing(page, trace_path)

        return {
            "description": description,
            "success": success,
            "error": error_detail,
            "console_count": len(console_events),
            "network_count": len(network_events),
            "screenshot": screenshot_path,
            "trace": trace,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--lat", type=float, default=-6.2)
    parser.add_argument("--lng", type=float, default=106.8)
    parser.add_argument("--zoom", type=int, default=8)
    parser.add_argument("--device")
    args = parser.parse_args()

    with PlaywrightDiagnostics(base_url=args.url) as diag:
        result = diag.investigate_map_pin_issue(args.lat, args.lng, args.zoom, args.device)
        print(json.dumps(result, indent=2, default=str))
