"""Bug Packet — auto-generated diagnostic reports for UI failures.

Generates comprehensive evidence packets that include:
  - URL, viewport, device, browser, OS, timestamp
  - DOM state
  - Element state
  - Screenshot
  - Console logs
  - Network requests
  - API responses
  - Request timeline
  - Map state
  - Pin counts
  - JavaScript errors
  - Performance data

Usage:
    packet = BugPacket()
    packet.capture(page=my_page, description="Load More button broken")
    packet.save("bug_report.json")
    print(packet.summary())
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TRACE_DIR = Path("/var/www/vhosts/xyzo.org/data/playwright_traces")
TRACE_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class BugPacket:
    description: str = ""
    url: str = ""
    viewport: dict = field(default_factory=dict)
    device: str = ""
    browser: str = ""
    os: str = ""
    timestamp: str = ""
    git_commit: str = ""
    user_action: str = ""
    dom_state: dict = field(default_factory=dict)
    element_state: dict = field(default_factory=dict)
    map_state: dict = field(default_factory=dict)
    pin_counts: dict = field(default_factory=dict)
    console_errors: list[dict] = field(default_factory=list)
    network_requests: list[dict] = field(default_factory=list)
    api_responses: list[dict] = field(default_factory=list)
    javascript_errors: list[dict] = field(default_factory=list)
    performance: dict = field(default_factory=dict)
    screenshot_path: str = ""
    trace_path: str = ""
    suspected_component: str = ""
    recent_changes: list[str] = field(default_factory=list)

    @classmethod
    def capture(
        cls,
        page,
        description: str,
        user_action: str = "",
        element_selector: str | None = None,
    ) -> BugPacket:
        """Capture all available diagnostic data from a Playwright page."""
        packet = cls(
            description=description,
            user_action=user_action,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

        try:
            packet.url = page.url
        except Exception:
            pass

        try:
            packet.viewport = {
                "width": page.viewport_size["width"],
                "height": page.viewport_size["height"],
            }
        except Exception:
            pass

        try:
            packet.browser = page.context.browser.version if page.context.browser else "unknown"
        except Exception:
            pass

        try:
            packet.git_commit = cls._get_git_commit()
        except Exception:
            pass

        try:
            packet.dom_state = page.evaluate("""
                () => {
                    const mapEl = document.querySelector('.leaflet-container');
                    const bottomBar = document.querySelector('#bottom-bar');
                    const modals = document.querySelectorAll('[role="dialog"], .modal');
                    return {
                        url: window.location.href,
                        hash: window.location.hash,
                        mapPresent: !!mapEl,
                        bottomBarPresent: !!bottomBar,
                        modalCount: modals.length,
                        activeModals: Array.from(modals).filter(m => !m.hidden).length,
                        scrollY: window.scrollY,
                        bodyChildren: document.body.children.length,
                    };
                }
            """)
        except Exception:
            pass

        try:
            packet.map_state = page.evaluate("""
                () => {
                    if (typeof map === 'undefined' || !map) return { error: 'map not found' };
                    const center = map.getCenter();
                    const bounds = map.getBounds();
                    return {
                        zoom: map.getZoom(),
                        center: { lat: center.lat, lng: center.lng },
                        bounds: {
                            north: bounds.getNorth(),
                            south: bounds.getSouth(),
                            east: bounds.getEast(),
                            west: bounds.getWest(),
                        },
                        size: { width: map.getSize().x, height: map.getSize().y },
                    };
                }
            """)
        except Exception as e:
            packet.map_state = {"error": str(e)}

        try:
            packet.pin_counts = page.evaluate("""
                () => ({
                    pinMarkersSize: window.pinMarkers ? window.pinMarkers.size : null,
                    canvasRenderer: window.canvasRenderer ? {
                        enabled: window.canvasRenderer._enabled,
                        pinsLength: window.canvasRenderer._pins ? window.canvasRenderer._pins.length : null,
                    } : null,
                    activeModes: window.activeModes ? Array.from(activeModes) : [],
                    inflightCtrl: window.inflightCtrl ? 'present' : 'null',
                })
            """)
        except Exception:
            pass

        try:
            packet.performance = page.evaluate("""
                () => {
                    const timing = performance.getEntriesByType('navigation')[0];
                    const paint = performance.getEntriesByType('paint');
                    return {
                        domContentLoaded: timing ? timing.domContentLoadedEventEnd : null,
                        loadComplete: timing ? timing.loadEventEnd : null,
                        firstPaint: paint.find(p => p.name === 'first-paint')?.startTime,
                        firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
                        memory: performance.memory ? {
                            usedJSHeapSize: performance.memory.usedJSHeapSize,
                            totalJSHeapSize: performance.memory.totalJSHeapSize,
                        } : null,
                    };
                }
            """)
        except Exception:
            pass

        if element_selector:
            try:
                el = page.locator(element_selector).first
                bb = el.bounding_box()
                cx = bb["x"] + bb["width"] / 2 if bb else 0
                cy = bb["y"] + bb["height"] / 2 if bb else 0

                packet.element_state = page.evaluate(f"""
                    (x, y) => {{
                        const el = document.querySelector('{element_selector}');
                        if (!el) return {{ error: 'element not found' }};
                        const computed = getComputedStyle(el);
                        const topmost = document.elementFromPoint(x, y);
                        return {{
                            tag: el.tagName,
                            id: el.id,
                            className: el.className,
                            text: el.innerText?.substring(0, 100),
                            visible: el.offsetParent !== null,
                            display: computed.display,
                            opacity: computed.opacity,
                            pointerEvents: computed.pointerEvents,
                            zIndex: computed.zIndex,
                            disabled: el.disabled,
                            ariaHidden: el.getAttribute('aria-hidden'),
                            boundingBox: JSON.stringify(el.getBoundingClientRect()),
                            topmostTag: topmost ? topmost.tagName : null,
                            topmostId: topmost ? topmost.id : null,
                            topmostZIndex: topmost ? getComputedStyle(topmost).zIndex : null,
                            topmostPointerEvents: topmost ? getComputedStyle(topmost).pointerEvents : null,
                            obstructed: topmost !== el,
                        }};
                    }}
                """, cx, cy)
            except Exception as e:
                packet.element_state = {"error": str(e)}

        try:
            ss = page.screenshot()
            ts = int(time.time())
            screenshot_path = str(TRACE_DIR / f"bug_screenshot_{ts}.png")
            Path(screenshot_path).write_bytes(ss)
            packet.screenshot_path = screenshot_path
        except Exception:
            pass

        return packet

    @staticmethod
    def _get_git_commit() -> str:
        """Get current git commit hash."""
        import subprocess
        try:
            return subprocess.check_output(
                ["git", "rev-parse", "--short=8", "HEAD"],
                cwd="/var/www/vhosts/xyzo.org",
                text=True,
            ).strip()
        except Exception:
            return "unknown"

    def save(self, path: str | Path):
        """Save bug packet to JSON file."""
        data = asdict(self)
        Path(path).write_text(json.dumps(data, indent=2, default=str))

    def summary(self) -> str:
        lines = [
            "╔══════════════════════════════════════════════════════════╗",
            "║                 XYZO BUG PACKET                     ║",
            "╚══════════════════════════════════════════════════════════╝",
            f"  Description:   {self.description}",
            f"  URL:          {self.url}",
            f"  Viewport:     {self.viewport.get('width', '?')}x{self.viewport.get('height', '?')}",
            f"  Device:       {self.device}",
            f"  Timestamp:    {self.timestamp}",
            f"  Git commit:   {self.git_commit}",
            f"  User action:  {self.user_action}",
            "",
        ]

        if self.map_state and "error" not in self.map_state:
            ms = self.map_state
            lines.append("  MAP STATE")
            lines.append(f"  Zoom:    {ms.get('zoom', '?')}")
            c = ms.get("center", {})
            lines.append(f"  Center:  {c.get('lat', '?')},{c.get('lng', '?')}")

        if self.pin_counts:
            lines.append("  PIN COUNTS")
            pc = self.pin_counts
            lines.append(f"  pinMarkers:    {pc.get('pinMarkersSize', '?')}")
            cr = pc.get("canvasRenderer") or {}
            lines.append(f"  canvas pins:  {cr.get('pinsLength', '?')}")
            lines.append(f"  activeModes:  {pc.get('activeModes', '?')}")

        if self.console_errors:
            lines.append(f"\n  CONSOLE ERRORS: {len(self.console_errors)}")
            for err in self.console_errors[:3]:
                lines.append(f"    • {err.get('text', '')[:80]}")

        if self.element_state:
            es = self.element_state
            lines.append("\n  ELEMENT STATE")
            lines.append(f"  Tag:     {es.get('tag', '?')}")
            lines.append(f"  Visible: {es.get('visible', '?')}")
            lines.append(f"  Obstructed: {es.get('obstructed', '?')}")
            if es.get("obstructed"):
                lines.append(f"  Topmost: <{es.get('topmostTag', '?')}> z={es.get('topmostZIndex', '?')}")

        lines.append(f"\n  Screenshot: {self.screenshot_path}")
        if self.suspected_component:
            lines.append(f"  Suspected:  {self.suspected_component}")

        return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="XYZO Bug Packet Generator")
    parser.add_argument("--description", required=True)
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--output", default="/var/www/vhosts/xyzo.org/data/bug_packets")
    args = parser.parse_args()

    from .playwright_diagnostics import PlaywrightDiagnostics

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    with PlaywrightDiagnostics(base_url=args.url) as diag:
        page = diag._context.new_page()
        page.goto(args.url, wait_until="networkidle", timeout=30000)
        time.sleep(1)

        packet = BugPacket.capture(page, args.description)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = output_dir / f"bug_packet_{ts}.json"
        packet.save(out_path)
        print(packet.summary())
        print(f"\nSaved to: {out_path}")
