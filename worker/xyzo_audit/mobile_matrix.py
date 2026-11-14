"""Mobile device matrix testing.

Tests the site across multiple viewport sizes and device emulations.
Compares desktop vs mobile pin rendering.

Usage:
    python -m worker.xyzo_audit.mobile_matrix https://xyzo.org /tmp/report
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout


DEVICES = [
    {"name": "Desktop 1920x1080", "width": 1920, "height": 1080},
    {"name": "Laptop 1366x768", "width": 1366, "height": 768},
    {"name": "Tablet 768x1024", "width": 768, "height": 1024},
    {"name": "iPhone 14 390x844", "width": 390, "height": 844},
    {"name": "Pixel 7 412x915", "width": 412, "height": 915},
    {"name": "Small 320x568", "width": 320, "height": 568},
]


@dataclass
class DeviceResult:
    device: str
    viewport: str
    load_ms: float = 0
    pins_rendered: int = 0
    map_visible: bool = False
    search_visible: bool = False
    elements_visible: int = 0
    elements_hidden: int = 0
    overflow: bool = False
    screenshot: str = ""
    errors: list = field(default_factory=list)
    interaction_results: list = field(default_factory=list)


@dataclass
class MobileReport:
    url: str
    devices_tested: int = 0
    results: list = field(default_factory=list)
    mobile_pin_bug: bool = False
    comparison: dict = field(default_factory=dict)


def test_device(url: str, device: dict, screenshot_dir: Path) -> DeviceResult:
    """Test the site on a specific device viewport."""
    result = DeviceResult(
        device=device["name"],
        viewport=f"{device['width']}x{device['height']}",
    )

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": device["width"], "height": device["height"]},
            user_agent="XYZO-Audit/1.0",
            is_mobile=device["width"] < 768,
            has_touch=device["width"] < 768,
        )
        page = context.new_page()

        # Capture errors
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)[:200]))

        # Load page
        t0 = time.monotonic()
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
        except PWTimeout:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        result.load_ms = round((time.monotonic() - t0) * 1000)

        time.sleep(2)

        # Check map visibility
        try:
            map_el = page.query_selector("#map")
            result.map_visible = map_el is not None and map_el.is_visible()
        except Exception:
            pass

        # Check search visibility
        try:
            search_el = page.query_selector("#search-input, #search-btn, .search-bar")
            result.search_visible = search_el is not None and search_el.is_visible()
        except Exception:
            pass

        # Count visible/hidden interactive elements
        try:
            visible = page.evaluate("""() => {
                const els = document.querySelectorAll('button, a[href], input, [role="button"]');
                let vis = 0, hid = 0;
                els.forEach(e => {
                    const r = e.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none') vis++;
                    else hid++;
                });
                return {visible: vis, hidden: hid};
            }""")
            result.elements_visible = visible.get("visible", 0)
            result.elements_hidden = visible.get("hidden", 0)
        except Exception:
            pass

        # Check for horizontal overflow (bad on mobile)
        try:
            result.overflow = page.evaluate("""() => {
                return document.documentElement.scrollWidth > document.documentElement.clientWidth;
            }""")
        except Exception:
            pass

        # Count pins (if map is loaded)
        try:
            result.pins_rendered = page.evaluate("""() => {
                // Check for Leaflet markers
                const markers = document.querySelectorAll('.leaflet-marker-icon, .leaflet-marker-pane img');
                // Check for canvas pins
                const canvas = document.querySelector('.leaflet-overlay-pane canvas');
                return markers.length + (canvas ? 1 : 0);
            }""")
        except Exception:
            pass

        # Test interactions (tap/click key elements)
        interaction_results = []
        test_targets = [
            ("Map zoom in", ".leaflet-control-zoom-in"),
            ("Map zoom out", ".leaflet-control-zoom-out"),
            ("Search input", "#search-input"),
            ("Reload button", "#reload-btn"),
        ]

        for name, sel in test_targets:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.click(timeout=3000)
                    time.sleep(0.3)
                    interaction_results.append({"target": name, "success": True})
                else:
                    interaction_results.append({"target": name, "success": False, "reason": "not visible"})
            except Exception as e:
                interaction_results.append({"target": name, "success": False, "reason": str(e)[:100]})

        result.interaction_results = interaction_results
        result.errors = errors

        # Screenshot
        fname = f"mobile-{device['width']}x{device['height']}.png"
        result.screenshot = str(screenshot_dir / fname)
        try:
            page.screenshot(path=result.screenshot)
        except Exception:
            pass

        browser.close()

    return result


def run_mobile_matrix(url: str, report_dir: str) -> MobileReport:
    """Test across all device viewports."""
    report_dir_path = Path(report_dir)
    screenshot_dir = report_dir_path / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)

    report = MobileReport(url=url)

    results = []
    desktop_pins = 0

    for device in DEVICES:
        print(f"    Testing {device['name']}...")
        result = test_device(url, device, screenshot_dir)
        results.append(result)
        report.devices_tested += 1

        if device["width"] >= 1366:
            desktop_pins = max(desktop_pins, result.pins_rendered)

    report.results = [asdict(r) for r in results]

    # Check for mobile pin bug (mobile shows significantly fewer pins)
    for r in results:
        device = r.device if isinstance(r, DeviceResult) else r
        if isinstance(device, dict):
            device = DeviceResult(**device)
        if device.viewport.startswith("3") or device.viewport.startswith("4"):
            if desktop_pins > 0 and device.pins_rendered < desktop_pins * 0.5:
                report.mobile_pin_bug = True
                report.comparison = {
                    "desktop_pins": desktop_pins,
                    "mobile_pins": device.pins_rendered,
                    "ratio": round(device.pins_rendered / max(desktop_pins, 1), 2),
                }

    with open(report_dir_path / "06-mobile-matrix.json", "w") as f:
        json.dump(asdict(report), f, indent=2, default=str)

    return report


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://xyzo.org"
    report_dir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/xyzo-audit"

    print(f"  Mobile matrix: {url}")
    report = run_mobile_matrix(url, report_dir)

    print(f"  Devices tested: {report.devices_tested}")
    print(f"  Mobile pin bug detected: {report.mobile_pin_bug}")
    if report.mobile_pin_bug:
        print(f"    Desktop: {report.comparison['desktop_pins']} pins")
        print(f"    Mobile: {report.comparison['mobile_pins']} pins")


if __name__ == "__main__":
    main()
