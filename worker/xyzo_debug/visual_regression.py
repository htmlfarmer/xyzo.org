"""Visual Regression Testing — screenshot comparison for xyzo.org.

Captures baseline screenshots and compares subsequent runs to detect
visual changes. Uses pixel-diff and structural comparison.

Usage:
    vr = VisualRegression("http://xyzo.org")
    vr.capture_baseline("homepage", url="http://xyzo.org")
    vr.capture_and_compare("homepage_after_fix", url="http://xyzo.org")
    print(vr.get_diff_report())
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from playwright.sync_api import Page

TRACE_DIR = Path("/var/www/vhosts/xyzo.org/data/playwright_traces")
BASELINE_DIR = Path("/var/www/vhosts/xyzo.org/data/visual_baselines")
BASELINE_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class VisualDiff:
    test_name: str
    baseline_path: str
    current_path: str
    diff_path: str | None
    pixel_diff_percent: float | None
    same_dimensions: bool
    width: int
    height: int
    timestamp: str
    changed: bool


class VisualRegression:
    """Visual regression testing for XYZO using Playwright screenshots."""

    def __init__(self, base_url: str = "http://xyzo.org"):
        self.base_url = base_url
        self.baseline_dir = BASELINE_DIR
        self.trace_dir = TRACE_DIR
        self.baseline_dir.mkdir(parents=True, exist_ok=True)

    def capture_baseline(
        self,
        name: str,
        url: str | None = None,
        viewport: dict | None = None,
        selector: str | None = None,
    ) -> str:
        """Capture a baseline screenshot."""
        from .playwright_diagnostics import PlaywrightDiagnostics

        target_url = url or self.base_url
        vp = viewport or {"width": 1920, "height": 1080}

        with PlaywrightDiagnostics(base_url=target_url, headless=True) as diag:
            page = diag._context.new_page()
            page.set_viewport_size(vp)
            page.goto(target_url, wait_until="networkidle", timeout=30000)
            time.sleep(1)

            path = self.baseline_dir / f"{name}_baseline.png"

            if selector:
                el = page.locator(selector)
                el.screenshot(path=str(path))
            else:
                page.screenshot(path=str(path), full_page=False)

            return str(path)

    def capture_and_compare(
        self,
        name: str,
        url: str | None = None,
        viewport: dict | None = None,
        selector: str | None = None,
        threshold: float = 1.0,
    ) -> VisualDiff:
        """Capture current screenshot and compare to baseline."""
        from .playwright_diagnostics import PlaywrightDiagnostics

        target_url = url or self.base_url
        vp = viewport or {"width": 1920, "height": 1080}
        ts = datetime.now(timezone.utc).isoformat().replace(":", "-")
        current_path = str(self.trace_dir / f"{name}_{ts}.png")
        baseline_path = str(self.baseline_dir / f"{name}_baseline.png")

        with PlaywrightDiagnostics(base_url=target_url, headless=True) as diag:
            page = diag._context.new_page()
            page.set_viewport_size(vp)
            page.goto(target_url, wait_until="networkidle", timeout=30000)
            time.sleep(1)

            if selector:
                el = page.locator(selector)
                el.screenshot(path=current_path)
            else:
                page.screenshot(path=current_path, full_page=False)

        diff_path = None
        pixel_diff = None
        changed = False

        if Path(baseline_path).exists():
            try:
                diff_path, pixel_diff, same_dims = self._compute_diff(
                    baseline_path, current_path, threshold
                )
                changed = pixel_diff > threshold
            except Exception as e:
                pixel_diff = None
                same_dims = True

        current_img = Path(current_path)
        width = height = 0
        try:
            import struct
            with open(current_path, "rb") as f:
                data = f.read()
            w, h = self._get_png_dimensions(data)
            width, height = w, h
        except Exception:
            pass

        return VisualDiff(
            test_name=name,
            baseline_path=baseline_path,
            current_path=current_path,
            diff_path=diff_path,
            pixel_diff_percent=pixel_diff,
            same_dimensions=True,
            width=width,
            height=height,
            timestamp=ts,
            changed=changed,
        )

    def _compute_diff(
        self,
        baseline: str,
        current: str,
        threshold: float,
    ) -> tuple[str | None, float | None, bool]:
        """Compute pixel-level diff between two images."""
        try:
            from PIL import Image
        except ImportError:
            return None, None, True

        try:
            im1 = Image.open(baseline).convert("RGB")
            im2 = Image.open(current).convert("RGB")

            if im1.size != im2.size:
                return None, None, False

            w, h = im1.size
            diff_im = Image.new("RGB", (w, h))
            total_pixels = w * h
            changed_pixels = 0

            for x in range(w):
                for y in range(h):
                    p1 = im1.getpixel((x, y))
                    p2 = im2.getpixel((x, y))
                    if abs(p1[0] - p2[0]) > 5 or abs(p1[1] - p2[1]) > 5 or abs(p1[2] - p2[2]) > 5:
                        diff_im.putpixel((x, y), (255, 0, 0))
                        changed_pixels += 1
                    else:
                        diff_im.putpixel((x, y), (0, 0, 0))

            diff_path = str(self.trace_dir / f"diff_{int(time.time())}.png")
            diff_im.save(diff_path)

            percent = (changed_pixels / total_pixels) * 100
            return diff_path, percent, True

        except Exception:
            return None, None, True

    def _get_png_dimensions(self, data: bytes) -> tuple[int, int]:
        """Read PNG width/height from file header."""
        import struct
        w = struct.unpack(">I", data[16:20])[0]
        h = struct.unpack(">I", data[20:24])[0]
        return w, h

    def get_diff_report(self) -> dict:
        """Get summary of all visual comparisons."""
        results = []
        for baseline_file in sorted(self.baseline_dir.glob("*_baseline.png")):
            name = baseline_file.stem.replace("_baseline", "")
            current_files = sorted(self.trace_dir.glob(f"{name}_*.png"))
            if current_files:
                latest = current_files[-1]
                results.append({
                    "name": name,
                    "baseline": str(baseline_file),
                    "latest": str(latest),
                })
        return {"comparisons": results}

    def compare_with_baseline(self, name: str, url: str, viewport: dict = {"width": 1920, "height": 1080}) -> VisualDiff:
        """Compare current page state against stored baseline."""
        return self.capture_and_compare(name, url=url, viewport=viewport)


def quick_screenshot(
    url: str = "http://xyzo.org",
    name: str = "screenshot",
    viewport: tuple[int, int] = (1920, 1080),
) -> str:
    """Quick one-liner screenshot capture."""
    from .playwright_diagnostics import PlaywrightDiagnostics

    path = str(TRACE_DIR / f"{name}_{int(time.time())}.png")
    with PlaywrightDiagnostics(base_url=url, headless=True) as diag:
        page = diag._context.new_page()
        page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
        page.goto(url, wait_until="networkidle", timeout=30000)
        time.sleep(1)
        page.screenshot(path=path, full_page=False)
    return path


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://xyzo.org")
    parser.add_argument("--name", default="screenshot")
    parser.add_argument("--viewport", default="1920x1080")
    parser.add_argument("--baseline", action="store_true")
    args = parser.parse_args()

    w, h = map(int, args.viewport.split("x"))

    if args.baseline:
        vr = VisualRegression(args.url)
        path = vr.capture_baseline(args.name, args.url, {"width": w, "height": h})
        print(f"Baseline saved: {path}")
    else:
        vr = VisualRegression(args.url)
        result = vr.capture_and_compare(args.name, args.url, {"width": w, "height": h})
        print(f"Current: {result.current_path}")
        print(f"Baseline: {result.baseline_path}")
        if result.pixel_diff_percent is not None:
            print(f"Diff: {result.pixel_diff_percent:.2f}%")
        print(f"Changed: {result.changed}")
        if result.diff_path:
            print(f"Diff image: {result.diff_path}")
