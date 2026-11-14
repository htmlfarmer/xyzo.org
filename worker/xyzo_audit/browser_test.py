"""Browser automation + UI torture test for XYZO.

Discovers all interactive elements, clicks/taps them, and reports pass/fail.
Uses Playwright for Chromium, with mobile emulation support.

Usage:
    python -m worker.xyzo_audit.browser_test https://xyzo.org /tmp/report
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout


@dataclass
class UIElement:
    tag: str
    selector: str
    text: str
    role: str
    visible: bool
    rect: dict  # {x, y, width, height}


@dataclass
class ClickResult:
    element: str
    selector: str
    action: str  # click, tap, type, hover
    success: bool
    error: Optional[str] = None
    duration_ms: float = 0
    caused_navigation: bool = False
    caused_new_request: bool = False
    screenshot: Optional[str] = None


@dataclass
class BrowserReport:
    url: str
    viewport: str
    load_time_ms: float = 0
    elements_found: int = 0
    elements_clicked: int = 0
    click_results: list = field(default_factory=list)
    console_errors: list = field(default_factory=list)
    console_warnings: list = field(default_factory=list)
    js_errors: list = field(default_factory=list)
    network_errors: list = field(default_factory=list)
    screenshots: list = field(default_factory=list)


# Selectors for interactive elements to discover
INTERACTIVE_SELECTORS = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[onclick]',
    '.leaflet-control-zoom-in',
    '.leaflet-control-zoom-out',
    '.leaflet-control-layers',
    '[data-action]',
    '#search-input',
    '#search-btn',
    '.tab-btn',
    '.filter-btn',
    '.modal-close',
    '.popup-close',
    '[aria-label]',
]

# Elements to skip (navigation to external sites, destructive actions)
SKIP_PATTERNS = [
    'a[href^="http"]:not([href*="xyzo.org"])',  # external links
    'a[href^="mailto:"]',
    'a[href^="tel:"]',
    '[data-action="delete"]',
    '[data-action="shutdown"]',
]


def discover_elements(page) -> list[UIElement]:
    """Find all interactive elements on the page."""
    elements = []
    seen = set()

    for selector in INTERACTIVE_SELECTORS:
        try:
            items = page.query_selector_all(selector)
            for el in items:
                try:
                    tag = el.evaluate("e => e.tagName.toLowerCase()")
                    text = (el.inner_text() or "")[:80].strip()
                    visible = el.is_visible()
                    box = el.bounding_box()

                    # Build a unique selector
                    el_id = el.get_attribute("id")
                    el_class = el.get_attribute("class") or ""
                    el_role = el.get_attribute("role") or ""
                    el_aria = el.get_attribute("aria-label") or ""

                    if el_id:
                        sel = f"#{el_id}"
                    elif el_aria:
                        sel = f'[aria-label="{el_aria}"]'
                    elif text:
                        sel = f'{tag}:has-text("{text[:30]}")'
                    else:
                        sel = selector

                    if sel in seen:
                        continue
                    seen.add(sel)

                    elements.append(UIElement(
                        tag=tag,
                        selector=sel,
                        text=text,
                        role=el_role or tag,
                        visible=visible,
                        rect={"x": round(box["x"]), "y": round(box["y"]),
                              "width": round(box["width"]), "height": round(box["height"])} if box else {},
                    ))
                except Exception:
                    continue
        except Exception:
            continue

    return elements


def test_click(page, element: UIElement, screenshot_dir: Path) -> ClickResult:
    """Click an element and observe the result."""
    t0 = time.monotonic()
    initial_url = page.url
    initial_requests = []

    # Track new requests during click
    requests_during = []
    def on_request(req):
        requests_during.append(req.url)
    page.on("request", on_request)

    try:
        el = page.query_selector(element.selector)
        if not el or not el.is_visible():
            return ClickResult(
                element=element.text or element.selector,
                selector=element.selector,
                action="click",
                success=False,
                error="element not found or not visible",
            )

        # Scroll into view if needed
        el.scroll_into_view_if_needed()
        time.sleep(0.1)

        # Click
        el.click(timeout=5000)
        duration = (time.monotonic() - t0) * 1000

        # Wait for potential navigation
        time.sleep(0.5)

        navigation = page.url != initial_url
        new_requests = len(requests_during) > 0

        # Take screenshot if something interesting happened
        screenshot_path = None
        if navigation or new_requests:
            fname = f"click_{element.tag}_{int(time.time())}.png"
            screenshot_path = str(screenshot_dir / fname)
            try:
                page.screenshot(path=screenshot_path)
            except Exception:
                screenshot_path = None

        # If a modal/popup opened, try to close it
        if not navigation:
            for close_sel in ['.modal-close', '.popup-close', '[aria-label="Close"]', 'button:has-text("×")']:
                try:
                    close_btn = page.query_selector(close_sel)
                    if close_btn and close_btn.is_visible():
                        close_btn.click(timeout=2000)
                        time.sleep(0.2)
                        break
                except Exception:
                    continue

        return ClickResult(
            element=element.text or element.selector,
            selector=element.selector,
            action="click",
            success=True,
            duration_ms=round(duration, 1),
            caused_navigation=navigation,
            caused_new_request=new_requests,
            screenshot=screenshot_path,
        )

    except PWTimeout:
        return ClickResult(
            element=element.text or element.selector,
            selector=element.selector,
            action="click",
            success=False,
            error="timeout (5s)",
            duration_ms=5000,
        )
    except Exception as e:
        return ClickResult(
            element=element.text or element.selector,
            selector=element.selector,
            action="click",
            success=False,
            error=str(e)[:200],
            duration_ms=(time.monotonic() - t0) * 1000,
        )
    finally:
        page.remove_listener("on_request", on_request)
        # Navigate back if we left the page
        if page.url != initial_url:
            try:
                page.goto(initial_url, wait_until="domcontentloaded", timeout=10000)
                time.sleep(1)
            except Exception:
                pass


def run_browser_test(url: str, report_dir: str) -> BrowserReport:
    """Run the full browser UI test."""
    report_dir_path = Path(report_dir)
    screenshot_dir = report_dir_path / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)

    report = BrowserReport(url=url, viewport="1280x720")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="XYZO-Audit/1.0",
        )
        page = context.new_page()

        # Capture console events
        console_errors = []
        console_warnings = []
        js_errors = []

        def on_console(msg):
            if msg.type == "error":
                console_errors.append(msg.text[:200])
            elif msg.type == "warning":
                console_warnings.append(msg.text[:200])

        def on_pageerror(err):
            js_errors.append(str(err)[:200])

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        # Capture network errors
        network_errors = []
        def on_request_failed(req):
            network_errors.append({
                "url": req.url[:200],
                "method": req.method,
                "failure": req.failure or "unknown",
            })
        page.on("requestfailed", on_request_failed)

        # Load page
        t0 = time.monotonic()
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
        except PWTimeout:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        report.load_time_ms = round((time.monotonic() - t0) * 1000)

        time.sleep(2)  # Let JS settle

        # Screenshot initial state
        page.screenshot(path=str(screenshot_dir / "01-initial-load.png"))

        # Discover elements
        elements = discover_elements(page)
        report.elements_found = len(elements)

        # Test each visible element
        click_results = []
        for el in elements:
            if not el.visible:
                continue
            # Skip tiny elements (likely hidden decorative)
            if el.rect.get("width", 0) < 5 or el.rect.get("height", 0) < 5:
                continue

            result = test_click(page, el, screenshot_dir)
            click_results.append(result)
            report.elements_clicked += 1

            if not result.success:
                print(f"  FAIL: {result.selector} — {result.error}")

        report.click_results = [asdict(r) for r in click_results]
        report.console_errors = console_errors
        report.console_warnings = console_warnings
        report.js_errors = js_errors
        report.network_errors = network_errors

        browser.close()

    # Save report
    with open(report_dir_path / "03-browser-test.json", "w") as f:
        json.dump(asdict(report), f, indent=2, default=str)

    return report


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://xyzo.org"
    report_dir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/xyzo-audit"

    print(f"  Browser test: {url}")
    report = run_browser_test(url, report_dir)

    failures = [r for r in report.click_results if not r.get("success")]
    print(f"  Elements found: {report.elements_found}")
    print(f"  Elements clicked: {report.elements_clicked}")
    print(f"  Failures: {len(failures)}")
    print(f"  Console errors: {len(report.console_errors)}")
    print(f"  JS errors: {len(report.js_errors)}")
    print(f"  Network errors: {len(report.network_errors)}")


if __name__ == "__main__":
    main()
