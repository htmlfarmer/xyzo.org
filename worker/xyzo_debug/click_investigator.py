"""Click Investigator — diagnose why an element can't be clicked.

Reproduces the exact browser state for a click failure and produces
an evidence report rather than letting the AI guess.

Usage:
    inv = ClickInvestigator("http://xyzo.org")
    result = inv.investigate("button", "Load More")
    print(result.summary())

    # Or as a decorator
    @inv.on_click_failure("button", "#submit")
    def test_submit(page):
        page.click("#submit")
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from playwright.sync_api import Page, TimeoutError as PWTimeout, Error

TRACE_DIR = Path("/var/www/vhosts/xyzo.org/data/playwright_traces")
TRACE_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class ElementState:
    selector: str
    exists: bool = False
    visible: bool = False
    display: str | None = None
    opacity: float | None = None
    pointer_events: str | None = None
    enabled: bool = False
    bounding_box: dict | None = None
    z_index: str | None = None
    aria_hidden: bool | None = None
    disabled: bool | None = None
    tag_name: str | None = None
    text: str | None = None
    event_listeners: list[str] = field(default_factory=list)
    topmost_element: dict | None = None
    obstruction: dict | None = None
    shadow_dom: bool = False
    inside_iframe: bool = False
    iframe_path: str | None = None


@dataclass
class ClickInvestigationResult:
    selector: str
    element_state: ElementState
    console_errors: list[dict]
    network_requests_after: list[dict]
    expected_state_change: str | None
    actual_state_change: str | None
    screenshot_path: str | None
    trace_path: str | None
    timestamp: str
    success: bool
    error: str | None


class ClickInvestigator:
    """Diagnose click failures with full evidence collection."""

    def __init__(self, base_url: str = "http://xyzo.org"):
        self.base_url = base_url

    def investigate(
        self,
        page: Page,
        selector: str,
        expected_change: Callable[[Page], bool] | None = None,
        timeout_ms: int = 5000,
    ) -> ClickInvestigationResult:
        """Run full click investigation on a page."""
        from .playwright_diagnostics import PlaywrightDiagnostics

        diag = PlaywrightDiagnostics(base_url=self.base_url)
        console_errors: list[dict] = []
        network_requests: list[dict] = []
        screenshot_path = ""
        trace_path = ""

        console_events: list[dict] = []
        network_events: list[dict] = []

        def on_console(msg):
            console_events.append({
                "type": msg.type,
                "text": msg.text,
                "location": dict(msg.location),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            if msg.type == "error":
                console_errors.append({"text": msg.text, "location": dict(msg.location)})

        def on_response(response):
            network_events.append({
                "url": response.url,
                "method": response.request.method,
                "status": response.status,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        page.on("console", on_console)
        page.on("response", on_response)

        state = self._capture_element_state(page, selector)

        before_state = self._capture_page_state(page)

        time.sleep(0.1)

        success = False
        error = None

        try:
            page.click(selector, timeout=timeout_ms)
            time.sleep(0.3)
            success = True
        except Error as e:
            error = str(e)
        except Exception as e:
            error = f"{e.__class__.__name__}: {e}"

        after_state = self._capture_page_state(page)

        expected_change_desc = None
        actual_change_desc = None
        if expected_change:
            try:
                expected_change_desc = expected_change(page)
                actual_change_desc = expected_change_desc
            except Exception as e:
                actual_change_desc = f"Error checking change: {e}"

        try:
            ss = page.screenshot()
            screenshot_path = str(TRACE_DIR / f"click_inv_{int(time.time())}.png")
            Path(screenshot_path).write_bytes(ss)
        except Exception:
            pass

        reqs_after = [
            r for r in network_events
            if r["url"].startswith("http") and r["method"] in ("GET", "POST")
        ]

        return ClickInvestigationResult(
            selector=selector,
            element_state=state,
            console_errors=console_errors,
            network_requests_after=reqs_after,
            expected_state_change=str(expected_change_desc),
            actual_state_change=str(actual_change_desc),
            screenshot_path=screenshot_path,
            trace_path=trace_path,
            timestamp=datetime.now(timezone.utc).isoformat(),
            success=success,
            error=error,
        )

    def _capture_element_state(self, page: Page, selector: str) -> ElementState:
        """Capture every diagnosable property of an element."""
        state = ElementState(selector=selector)

        try:
            el = page.locator(selector).first
            state.exists = True

            try:
                state.visible = el.is_visible(timeout=1000)
            except Exception:
                state.visible = False

            try:
                state.enabled = el.is_enabled(timeout=1000)
            except Exception:
                state.enabled = False

            try:
                bb = el.bounding_box
                state.bounding_box = bb
            except Exception:
                pass

            try:
                state.display = el.evaluate("el => getComputedStyle(el).display")
                state.opacity = float(el.evaluate("el => getComputedStyle(el).opacity"))
                state.pointer_events = el.evaluate("el => getComputedStyle(el).pointerEvents")
                state.z_index = el.evaluate("el => getComputedStyle(el).zIndex")
            except Exception:
                pass

            try:
                state.aria_hidden = el.get_attribute("aria-hidden") == "true"
                state.disabled = el.get_attribute("disabled") is not None
                state.tag_name = el.evaluate("el => el.tagName")
                state.text = el.inner_text(timeout=500)
            except Exception:
                pass

            try:
                state.shadow_dom = el.evaluate("el => el.shadowRoot !== null")
            except Exception:
                pass

            try:
                state.inside_iframe = el.evaluate("""
                    el => {
                        let cur = el;
                        while (cur) {
                            if (cur.tagName === 'IFRAME') return true;
                            cur = cur.parentElement;
                        }
                        return false;
                    }
                """)
            except Exception:
                pass

            try:
                state.event_listeners = el.evaluate("""
                    el => {
                        if (!window.getEventListeners) return ['N/A'];
                        try {
                            return Object.keys(window.getEventListeners(el) || {});
                        } catch(e) {
                            return ['unavailable'];
                        }
                    }
                """) or []
            except Exception:
                state.event_listeners = ["error_checking"]

            if state.bounding_box and state.visible:
                try:
                    cx = state.bounding_box["x"] + state.bounding_box["width"] / 2
                    cy = state.bounding_box["y"] + state.bounding_box["height"] / 2
                    topmost = page.evaluate(f"""
                        (x, y) => {{
                            const el = document.elementFromPoint(x, y);
                            if (!el) return null;
                            return {{
                                tag: el.tagName,
                                id: el.id,
                                className: el.className,
                                zIndex: getComputedStyle(el).zIndex,
                                pointerEvents: getComputedStyle(el).pointerEvents,
                                visibility: getComputedStyle(el).visibility,
                                opacity: getComputedStyle(el).opacity,
                                display: getComputedStyle(el).display,
                            }};
                        }}
                    """, cx, cy)
                    state.topmost_element = topmost

                    if topmost and state.tag_name:
                        if topmost.get("tag", "").lower() != state.tag_name.lower():
                            state.obstruction = topmost
                except Exception:
                    pass

        except Exception:
            pass

        return state

    def _capture_page_state(self, page: Page) -> dict:
        """Capture general page state indicators."""
        try:
            return page.evaluate("""
                () => ({
                    url: window.location.href,
                    mapZoom: window.map ? window.map.getZoom() : null,
                    mapCenter: window.map ? {
                        lat: window.map.getCenter().lat,
                        lng: window.map.getCenter().lng,
                    } : null,
                    pinCount: window.pinMarkers ? window.pinMarkers.size : null,
                    activeModes: window.activeModes ? Array.from(activeModes) : [],
                    canvasEnabled: window.canvasRenderer ? window.canvasRenderer._enabled : null,
                })
            """)
        except Exception:
            return {}

    def summary(self, result: ClickInvestigationResult) -> str:
        """Format a human-readable click investigation report."""
        s = result.element_state
        lines = [
            "╔══════════════════════════════════════════════════════════╗",
            "║              XYZO CLICK INVESTIGATION                   ║",
            "╚══════════════════════════════════════════════════════════╝",
            f"  Selector:   {result.selector}",
            f"  Timestamp:  {result.timestamp}",
            f"  Success:    {'✓ YES' if result.success else '✗ NO'}",
            f"  Error:      {result.error or 'none'}",
            "",
            "  ELEMENT STATE",
            f"  Exists:        {'YES' if s.exists else 'NO'}",
            f"  Visible:        {'YES' if s.visible else 'NO'}",
            f"  Enabled:        {'YES' if s.enabled else 'NO'}",
            f"  Display:        {s.display or 'unknown'}",
            f"  Opacity:       {s.opacity}",
            f"  Pointer events: {s.pointer_events or 'unknown'}",
            f"  Z-index:        {s.z_index or 'none'}",
            f"  Aria-hidden:   {s.aria_hidden}",
            f"  Disabled:       {s.disabled}",
            f"  Tag:            {s.tag_name or 'unknown'}",
            f"  Text:           {(s.text or '')[:50]!r}",
            f"  Shadow DOM:     {s.shadow_dom}",
            f"  Inside iframe:  {s.inside_iframe}",
            f"  Event lsns:    {s.event_listeners or 'unknown'}",
        ]

        if s.bounding_box:
            bb = s.bounding_box
            lines.append(f"  Bounding box: x={bb['x']:.0f} y={bb['y']:.0f} w={bb['width']:.0f} h={bb['height']:.0f}")

        if s.topmost_element:
            lines.append("")
            lines.append("  TOPMOST ELEMENT AT CLICK POINT")
            t = s.topmost_element
            lines.append(f"    Tag:          {t.get('tag', '?')}")
            lines.append(f"    ID:           {t.get('id', '') or '(none)'}")
            lines.append(f"    zIndex:       {t.get('zIndex', '?')}")
            lines.append(f"    pointerEvents: {t.get('pointerEvents', '?')}")
            lines.append(f"    visibility:    {t.get('visibility', '?')}")

        if s.obstruction:
            lines.append("")
            lines.append("  ⚠ OBSTRUCTION DETECTED — element at click point differs from target")
            o = s.obstruction
            lines.append(f"    Obstructing tag: {o.get('tag', '?')}")
            lines.append(f"    Obstructing zIndex: {o.get('zIndex', '?')}")

        lines.extend([
            "",
            "  CONSOLE",
            f"  Errors:      {len(result.console_errors)}",
        ])
        for err in result.console_errors[:3]:
            lines.append(f"    • {err['text'][:80]}")

        lines.extend([
            "",
            "  NETWORK AFTER CLICK",
            f"  Requests:    {len(result.network_requests_after)}",
        ])
        for req in result.network_requests_after[:5]:
            lines.append(f"    {req['method']} {req['url'][:70]} → {req['status']}")

        if result.screenshot_path:
            lines.append(f"\n  Screenshot: {result.screenshot_path}")
        if result.trace_path:
            lines.append(f"  Trace:      {result.trace_path}")

        if not result.success:
            if s.display == "none" or s.opacity == 0:
                lines.append("\n  DIAGNOSIS: Element is hidden via CSS (display:none or opacity:0)")
            elif s.pointer_events == "none":
                lines.append("\n  DIAGNOSIS: Element has pointer-events:none — CSS blocking clicks")
            elif s.obstruction:
                lines.append("\n  DIAGNOSIS: Another element covers this button (z-index issue)")
            elif not s.enabled:
                lines.append("\n  DIAGNOSIS: Element is disabled")
            elif not s.exists:
                lines.append("\n  DIAGNOSIS: Element does not exist in DOM")
            else:
                lines.append("\n  DIAGNOSIS: Unknown — see error details above")

        return "\n".join(lines)


def investigate_button(
    url: str,
    selector: str,
    expected_change: Callable[[Page], bool] | None = None,
) -> ClickInvestigationResult:
    """One-shot click investigation."""
    from .playwright_diagnostics import PlaywrightDiagnostics

    with PlaywrightDiagnostics(base_url=url) as diag:
        page = diag._context.new_page()
        page.goto(url, wait_until="networkidle", timeout=30000)
        inv = ClickInvestigator(base_url=url)
        return inv.investigate(page, selector, expected_change)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="XYZO Click Investigator")
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--selector", required=True)
    args = parser.parse_args()

    result = investigate_button(args.url, args.selector)
    inv = ClickInvestigator(base_url=args.url)
    print(inv.summary(result))
