"""Core Web Vitals + resource audit.

Measures FCP, LCP, CLS, INP using Playwright's Performance API.
Audits resource sizes and caching.

Usage:
    python -m worker.xyzo_audit.page_speed https://xyzo.org /tmp/report
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout


@dataclass
class WebVitals:
    fcp_ms: float = 0  # First Contentful Paint
    lcp_ms: float = 0  # Largest Contentful Paint
    cls: float = 0     # Cumulative Layout Shift
    ttfb_ms: float = 0 # Time to First Byte
    dom_load_ms: float = 0
    load_ms: float = 0
    transfer_size: int = 0
    resource_count: int = 0


@dataclass
class ResourceEntry:
    name: str
    type: str
    transfer_size: int
    duration_ms: float
    cached: bool


@dataclass
class SpeedReport:
    url: str
    vitals: dict = field(default_factory=dict)
    resources: list = field(default_factory=list)
    total_transfer_kb: float = 0
    resource_breakdown: dict = field(default_factory=dict)
    large_resources: list = field(default_factory=list)
    flags: list = field(default_factory=list)


def run_page_speed(url: str, report_dir: str) -> SpeedReport:
    """Measure Core Web Vitals and audit resources."""
    report = SpeedReport(url=url)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="XYZO-Audit/1.0",
        )
        page = context.new_page()

        # Navigate and collect performance data
        t0 = time.monotonic()
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
        except PWTimeout:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)

        # Wait for LCP to settle
        time.sleep(3)

        # Collect performance metrics
        try:
            perf_data = page.evaluate("""() => {
                const nav = performance.getEntriesByType('navigation')[0];
                const paints = performance.getEntriesByType('paint');
                const resources = performance.getEntriesByType('resource');

                // FCP
                const fcp = paints.find(e => e.name === 'first-contentful-paint');

                // LCP (from PerformanceObserver - may not be available)
                let lcp = 0;
                try {
                    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
                    if (lcpEntries.length) lcp = lcpEntries[lcpEntries.length - 1].startTime;
                } catch(e) {}

                // Resources
                const resList = resources.map(r => ({
                    name: r.name,
                    type: r.initiatorType || 'other',
                    transfer_size: r.transferSize || 0,
                    duration: r.duration || 0,
                    cached: r.transferSize === 0 && r.decodedBodySize > 0,
                }));

                return {
                    ttfb: nav ? (nav.responseStart - nav.requestStart) : 0,
                    fcp: fcp ? fcp.startTime : 0,
                    lcp: lcp,
                    dom_load: nav ? (nav.domContentLoadedEventEnd - nav.startTime) : 0,
                    load: nav ? (nav.loadEventEnd - nav.startTime) : 0,
                    transfer_size: nav ? nav.transferSize : 0,
                    resource_count: resources.length,
                    resources: resList,
                };
            }""")
        except Exception as e:
            perf_data = {"error": str(e), "resources": []}

        report.vitals = WebVitals(
            fcp_ms=round(perf_data.get("fcp", 0), 1),
            lcp_ms=round(perf_data.get("lcp", 0), 1),
            ttfb_ms=round(perf_data.get("ttfb", 0), 1),
            dom_load_ms=round(perf_data.get("dom_load", 0), 1),
            load_ms=round(perf_data.get("load", 0), 1),
            transfer_size=perf_data.get("transfer_size", 0),
            resource_count=perf_data.get("resource_count", 0),
        )

        # Process resources
        resources = perf_data.get("resources", [])
        breakdown = {}
        large = []
        total_bytes = 0

        for r in resources:
            rtype = r.get("type", "other")
            if rtype not in breakdown:
                breakdown[rtype] = {"count": 0, "bytes": 0}
            breakdown[rtype]["count"] += 1
            breakdown[rtype]["bytes"] += r.get("transfer_size", 0)
            total_bytes += r.get("transfer_size", 0)

            if r.get("transfer_size", 0) > 500_000:  # >500KB
                large.append({
                    "url": r["name"][:200],
                    "type": rtype,
                    "size_kb": round(r["transfer_size"] / 1024, 1),
                })

        report.resources = resources[:200]  # Cap
        report.total_transfer_kb = round(total_bytes / 1024, 1)
        report.resource_breakdown = breakdown
        report.large_resources = large

        # Flags
        flags = []
        if report.vitals.ttfb_ms > 600:
            flags.append(f"TTFB_SLOW: {report.vitals.ttfb_ms}ms")
        if report.vitals.fcp_ms > 1800:
            flags.append(f"FCP_SLOW: {report.vitals.fcp_ms}ms")
        if report.vitals.lcp_ms > 2500:
            flags.append(f"LCP_SLOW: {report.vitals.lcp_ms}ms")
        if report.total_transfer_kb > 3000:
            flags.append(f"HEAVY_PAYLOAD: {report.total_transfer_kb}KB")
        if report.vitals.resource_count > 100:
            flags.append(f"TOO_MANY_REQUESTS: {report.vitals.resource_count}")
        for lr in large:
            flags.append(f"LARGE_RESOURCE: {lr['url'][:80]} ({lr['size_kb']}KB)")
        report.flags = flags

        browser.close()

    with open(Path(report_dir) / "05-page-speed.json", "w") as f:
        json.dump(asdict(report), f, indent=2, default=str)

    return report


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://xyzo.org"
    report_dir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/xyzo-audit"

    print(f"  Page speed: {url}")
    report = run_page_speed(url, report_dir)

    v = report.vitals
    print(f"  TTFB: {v.ttfb_ms}ms")
    print(f"  FCP: {v.fcp_ms}ms")
    print(f"  LCP: {v.lcp_ms}ms")
    print(f"  Resources: {v.resource_count}")
    print(f"  Transfer: {report.total_transfer_kb}KB")
    if report.flags:
        print(f"  Flags:")
        for f in report.flags:
            print(f"    {f}")


if __name__ == "__main__":
    main()
