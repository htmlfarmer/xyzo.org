"""Network inspector — captures every request during page load.

Tracks timing, size, status, and flags problematic requests.

Usage:
    python -m worker.xyzo_audit.network_inspector https://xyzo.org /tmp/report
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout


@dataclass
class RequestEntry:
    url: str
    method: str
    resource_type: str
    status: int | None
    duration_ms: float
    request_size: int
    response_size: int
    content_type: str
    initiator: str
    from_cache: bool
    failed: bool
    failure_text: str | None = None
    flags: list = field(default_factory=list)


@dataclass
class NetworkReport:
    url: str
    total_requests: int = 0
    total_bytes: int = 0
    total_duration_ms: float = 0
    failed_requests: int = 0
    slow_requests: int = 0
    large_responses: int = 0
    duplicate_urls: int = 0
    requests: list = field(default_factory=list)
    by_type: dict = field(default_factory=dict)
    by_domain: dict = field(default_factory=dict)
    flags: list = field(default_factory=list)


def run_network_inspection(url: str, report_dir: str) -> NetworkReport:
    """Load a page and capture all network activity."""
    report = NetworkReport(url=url)
    entries = []
    seen_urls = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="XYZO-Audit/1.0",
        )
        page = context.new_page()

        # Track requests
        request_start = {}

        def on_request(req):
            request_start[req.url] = time.monotonic()

        def on_response(resp):
            req = resp.request
            start = request_start.pop(req.url, time.monotonic())
            duration = (time.monotonic() - start) * 1000

            # Get response size
            body_size = 0
            content_type = ""
            try:
                headers = resp.headers
                content_type = headers.get("content-type", "")
                cl = headers.get("content-length", "0")
                body_size = int(cl) if cl.isdigit() else 0
            except Exception:
                pass

            # Check cache
            from_cache = False
            try:
                perf_entries = page.evaluate(
                    "() => performance.getEntriesByType('resource').filter(e => e.name === arguments[0])",
                    req.url,
                )
                if perf_entries:
                    from_cache = perf_entries[0].transferSize == 0
            except Exception:
                pass

            flags = []
            if resp.status >= 400:
                flags.append(f"HTTP_{resp.status}")
            if duration > 1000:
                flags.append("SLOW")
            if body_size > 5_000_000:
                flags.append("LARGE")
            if req.url in seen_urls:
                flags.append("DUPLICATE")
            seen_urls[req.url] = seen_urls.get(req.url, 0) + 1

            entry = RequestEntry(
                url=req.url[:300],
                method=req.method,
                resource_type=req.resource_type,
                status=resp.status,
                duration_ms=round(duration, 1),
                request_size=0,
                response_size=body_size,
                content_type=content_type,
                initiator="",
                from_cache=from_cache,
                failed=False,
                flags=flags,
            )
            entries.append(entry)

        def on_request_failed(req):
            nonlocal entries
            flags = ["FAILED"]
            if req.failure:
                flags.append(req.failure.upper().replace(" ", "_"))
            entries.append(RequestEntry(
                url=req.url[:300],
                method=req.method,
                resource_type=req.resource_type,
                status=None,
                duration_ms=0,
                request_size=0,
                response_size=0,
                content_type="",
                initiator="",
                from_cache=False,
                failed=True,
                failure_text=req.failure,
                flags=flags,
            ))

        page.on("request", on_request)
        page.on("response", on_response)
        page.on("requestfailed", on_request_failed)

        # Load page
        t0 = time.monotonic()
        try:
            page.goto(url, wait_until="networkidle", timeout=30000)
        except PWTimeout:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        load_ms = (time.monotonic() - t0) * 1000

        # Wait for any late requests
        time.sleep(2)

        browser.close()

    # Build report
    report.total_requests = len(entries)
    report.total_bytes = sum(e.response_size for e in entries)
    report.total_duration_ms = round(load_ms, 1)
    report.failed_requests = sum(1 for e in entries if e.failed)
    report.slow_requests = sum(1 for e in entries if e.duration_ms > 1000)
    report.large_responses = sum(1 for e in entries if e.response_size > 5_000_000)
    report.duplicate_urls = sum(1 for url, count in seen_urls.items() if count > 1)

    # Group by type
    by_type = {}
    for e in entries:
        t = e.resource_type or "other"
        if t not in by_type:
            by_type[t] = {"count": 0, "bytes": 0, "ms": 0}
        by_type[t]["count"] += 1
        by_type[t]["bytes"] += e.response_size
        by_type[t]["ms"] += e.duration_ms
    report.by_type = by_type

    # Group by domain
    by_domain = {}
    for e in entries:
        try:
            domain = urlparse(e.url).netloc
        except Exception:
            domain = "unknown"
        if domain not in by_domain:
            by_domain[domain] = {"count": 0, "bytes": 0, "ms": 0}
        by_domain[domain]["count"] += 1
        by_domain[domain]["bytes"] += e.response_size
        by_domain[domain]["ms"] += e.duration_ms
    report.by_domain = by_domain

    # Global flags
    all_flags = []
    for e in entries:
        for f in e.flags:
            all_flags.append({"url": e.url[:100], "flag": f, "detail": f"status={e.status}, duration={e.duration_ms}ms, size={e.response_size}B"})
    report.flags = all_flags[:50]  # Cap at 50

    report.requests = [asdict(e) for e in entries]

    # Save
    with open(Path(report_dir) / "04-network.json", "w") as f:
        json.dump(asdict(report), f, indent=2, default=str)

    return report


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://xyzo.org"
    report_dir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/xyzo-audit"

    print(f"  Network inspection: {url}")
    report = run_network_inspection(url, report_dir)

    print(f"  Total requests: {report.total_requests}")
    print(f"  Total bytes: {report.total_bytes:,}")
    print(f"  Failed: {report.failed_requests}")
    print(f"  Slow (>1s): {report.slow_requests}")
    print(f"  Large (>5MB): {report.large_responses}")
    print(f"  Duplicates: {report.duplicate_urls}")
    if report.flags:
        print(f"  Flags: {len(report.flags)}")
        for f in report.flags[:5]:
            print(f"    {f['flag']}: {f['url']}")


if __name__ == "__main__":
    main()
