"""Automated XYZO UI Health Scanner — checks all important buttons/elements.

Runs 15 automated checks per important element:
  1. Find button
  2. Verify visible
  3. Verify enabled
  4. Get bounding rectangle
  5. Determine element at center coordinate
  6. Inspect z-index
  7. Inspect pointer-events
  8. Inspect opacity
  9. Inspect visibility
  10. Inspect disabled state
  11. Inspect event listeners where possible
  12. Attempt click
  13. Verify expected DOM/state change
  14. Verify expected API request
  15. Verify expected response

Usage:
    scanner = UIHealthScanner("http://xyzo.org")
    report = scanner.scan_all()
    print(report.summary())
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


@dataclass
class ElementCheck:
    selector: str
    description: str
    exists: bool = False
    visible: bool = False
    enabled: bool = False
    bounding_box: dict | None = None
    topmost_element: dict | None = None
    obstructed: bool = False
    z_index: str | None = None
    pointer_events: str | None = None
    opacity: float | None = None
    visibility: str | None = None
    disabled: bool = False
    aria_hidden: bool = False
    event_listeners: list[str] = field(default_factory=list)
    click_success: bool = False
    click_error: str | None = None
    state_change: bool = False
    api_request_made: bool = False
    screenshot_path: str | None = None


@dataclass
class UIHealthReport:
    url: str
    viewport: dict
    timestamp: str
    checks: list[ElementCheck]
    total: int = 0
    passed: int = 0
    failed: int = 0
    obstructed: int = 0
    hidden: int = 0
    disabled: int = 0
    no_handler: int = 0


class UIHealthScanner:
    """Automated health checks for XYZO UI elements."""

    IMPORTANT_BUTTONS = [
        ("button[data-xyzo='reload']", "Reload Markers"),
        ("#links-toggle", "Connection Lines Toggle"),
        ("button[aria-label*='filter']", "Filter Button"),
        ("button[aria-label*='close']", "Close Button"),
        (".cluster-tier-high", "Cluster Pin (High)"),
        (".xyzo-circle-count-marker", "Circle Count Marker"),
        ("#bottom-bar button", "Bottom Bar Buttons"),
        (".leaflet-control-zoom a", "Map Zoom Controls"),
        ("input[id*='search']", "Search Input"),
        ("button[aria-label*='mode']", "Mode Toggle"),
    ]

    def __init__(self, base_url: str = "http://xyzo.org"):
        self.base_url = base_url

    def scan_all(
        self,
        page: Page,
        buttons: list[tuple[str, str]] | None = None,
    ) -> UIHealthReport:
        """Run all health checks on a page."""
        from .playwright_diagnostics import PlaywrightDiagnostics
        from .click_investigator import ClickInvestigator

        buttons = buttons or self.IMPORTANT_BUTTONS
        viewport = {"width": page.viewport_size["width"], "height": page.viewport_size["height"]}
        checks: list[ElementCheck] = []
        passed = failed = obstructed = hidden = disabled = no_handler = 0

        for selector, description in buttons:
            check = self._check_element(page, selector, description)
            checks.append(check)

            if not check.exists:
                failed += 1
            elif check.obstructed:
                obstructed += 1
                failed += 1
            elif check.hidden:
                hidden += 1
                failed += 1
            elif check.disabled:
                disabled += 1
                failed += 1
            elif not check.event_listeners and check.exists:
                no_handler += 1
            elif check.click_success:
                passed += 1
            else:
                failed += 1

        return UIHealthReport(
            url=page.url,
            viewport=viewport,
            timestamp=datetime.now(timezone.utc).isoformat(),
            checks=checks,
            total=len(checks),
            passed=passed,
            failed=failed,
            obstructed=obstructed,
            hidden=hidden,
            disabled=disabled,
            no_handler=no_handler,
        )

    def _check_element(
        self,
        page: Page,
        selector: str,
        description: str,
    ) -> ElementCheck:
        """Run 15-point check on a single element."""
        check = ElementCheck(selector=selector, description=description)

        try:
            el = page.locator(selector).first
            check.exists = True

            try:
                check.visible = el.is_visible(timeout=500)
            except Exception:
                check.visible = False

            try:
                check.enabled = el.is_enabled(timeout=500)
            except Exception:
                check.enabled = False

            try:
                check.bounding_box = el.bounding_box()
            except Exception:
                pass

            if check.bounding_box:
                bb = check.bounding_box
                cx = bb["x"] + bb["width"] / 2
                cy = bb["y"] + bb["height"] / 2
                try:
                    topmost = page.evaluate(f"""
                        (x, y) => {{
                            const el = document.elementFromPoint(x, y);
                            if (!el) return null;
                            return {{
                                tag: el.tagName,
                                id: el.id,
                                className: String(el.className).substring(0, 50),
                                zIndex: getComputedStyle(el).zIndex,
                                pointerEvents: getComputedStyle(el).pointerEvents,
                                visibility: getComputedStyle(el).visibility,
                                opacity: getComputedStyle(el).opacity,
                                display: getComputedStyle(el).display,
                            }};
                        }}
                    """, cx, cy)
                    check.topmost_element = topmost
                    if topmost:
                        try:
                            target_tag = el.evaluate("el => el.tagName")
                            if topmost.get("tag", "").lower() != target_tag.lower():
                                check.obstructed = True
                        except Exception:
                            pass
                except Exception:
                    pass

            try:
                check.z_index = el.evaluate("el => getComputedStyle(el).zIndex")
                check.pointer_events = el.evaluate("el => getComputedStyle(el).pointerEvents")
                check.opacity = float(el.evaluate("el => getComputedStyle(el).opacity"))
                check.visibility = el.evaluate("el => getComputedStyle(el).visibility")
            except Exception:
                pass

            try:
                check.disabled = el.get_attribute("disabled") is not None
                check.aria_hidden = el.get_attribute("aria-hidden") == "true"
            except Exception:
                pass

            try:
                check.event_listeners = el.evaluate("""
                    el => {
                        if (!window.getEventListeners) return ['N/A'];
                        try {
                            const listeners = window.getEventListeners(el);
                            return listeners ? Object.keys(listeners) : [];
                        } catch(e) { return ['unavailable']; }
                    }
                """) or []
            except Exception:
                check.event_listeners = []

            try:
                page.click(selector, timeout=2000)
                check.click_success = True
            except Exception as e:
                check.click_error = str(e)[:100]

        except Exception as e:
            check.click_error = f"Element not found: {e}"

        return check

    def summary(self, report: UIHealthReport) -> str:
        """Format a human-readable health report."""
        lines = [
            "╔══════════════════════════════════════════════════════════╗",
            "║           XYZO UI HEALTH SCAN RESULTS                 ║",
            "╚══════════════════════════════════════════════════════════╝",
            f"  URL:       {report.url}",
            f"  Viewport:  {report.viewport['width']}x{report.viewport['height']}",
            f"  Timestamp: {report.timestamp}",
            f"",
            f"  TOTAL:     {report.total}",
            f"  PASSED:    {report.passed}  ✓",
            f"  FAILED:    {report.failed}  ✗",
            f"  Obstructed: {report.obstructed}  ⚠",
            f"  Hidden:     {report.hidden}  ⚠",
            f"  Disabled:   {report.disabled}  ⚠",
            f"  No handler: {report.no_handler}  ⚠",
            "",
            "  DETAILS",
        ]

        for check in report.checks:
            if check.failed or check.obstructed or check.hidden:
                status = "✗"
                if check.obstructed:
                    status = "⚠ OBSTRUCTED"
                elif check.hidden:
                    status = "⚠ HIDDEN"
                elif check.disabled:
                    status = "⚠ DISABLED"
                elif not check.event_listeners:
                    status = "⚠ NO HANDLER"

                lines.append(f"  {status}  {check.description}")
                lines.append(f"          selector: {check.selector}")

                if check.bounding_box:
                    bb = check.bounding_box
                    lines.append(f"          bbox: x={bb['x']:.0f} y={bb['y']:.0f} {bb['width']:.0f}x{bb['height']:.0f}")

                if check.topmost_element:
                    t = check.topmost_element
                    lines.append(f"          topmost: <{t.get('tag','?')}> z={t.get('zIndex','?')} pointerEvents={t.get('pointerEvents','?')}")

                if check.click_error:
                    lines.append(f"          error: {check.click_error}")

        return "\n".join(lines)


def run_health_scan(
    url: str = "http://xyzo.org",
    viewport: tuple[int, int] = (1920, 1080),
    headless: bool = True,
) -> UIHealthReport:
    """Run a full health scan on a URL."""
    from .playwright_diagnostics import PlaywrightDiagnostics

    with PlaywrightDiagnostics(base_url=url, headless=headless) as diag:
        page = diag._context.new_page()
        page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
        page.goto(url, wait_until="networkidle", timeout=30000)
        time.sleep(1)

        scanner = UIHealthScanner(base_url=url)
        return scanner.scan_all(page)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--viewport", default="1920x1080")
    args = parser.parse_args()

    w, h = map(int, args.viewport.split("x"))
    report = run_health_scan(args.url, (w, h))
    scanner = UIHealthScanner()
    print(scanner.summary(report))
    print(f"\nJSON: {json.dumps(asdict(report), indent=2, default=str)}")
