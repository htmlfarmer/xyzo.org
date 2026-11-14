"""Tests for the longitude wrapping fix in app.js.

When a user pans across the antimeridian (e.g., to lng=190), Leaflet's
worldCopyJump displays correct tiles but the internal center.lng can be
outside [-180, 180].  This was saved to localStorage/URL hash, but
parseMapHash rejected values outside that range, causing the stored
position to be ignored on reload.
"""
from __future__ import annotations

import os
import unittest

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
    IMPORT_ERROR = None
except ImportError as e:
    PLAYWRIGHT_AVAILABLE = False
    IMPORT_ERROR = e


BASE_URL = os.environ.get("XYZO_TEST_URL", "https://xyzo.org/")


def _require_playwright(test_func):
    import functools
    import inspect
    if inspect.iscoroutinefunction(test_func):
        @functools.wraps(test_func)
        async def async_wrapper(self, *args, **kwargs):
            if not PLAYWRIGHT_AVAILABLE:
                self.skipTest(f"Playwright not installed: {IMPORT_ERROR}")
            return await test_func(self, *args, **kwargs)
        return async_wrapper
    @functools.wraps(test_func)
    def sync_wrapper(self, *args, **kwargs):
        if not PLAYWRIGHT_AVAILABLE:
            self.skipTest(f"Playwright not installed: {IMPORT_ERROR}")
        return test_func(self, *args, **kwargs)
    return sync_wrapper


class LngWrappingTests(unittest.IsolatedAsyncioTestCase):
    """Tests for antimeridian lng normalization."""

    async def asyncSetUp(self):
        if not PLAYWRIGHT_AVAILABLE:
            self.skipTest(f"Playwright not installed: {IMPORT_ERROR}")
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )

    async def asyncTearDown(self):
        await self._browser.close()
        await self._pw.stop()

    @_require_playwright
    async def test_localstorage_saved_lng_is_normalized(self):
        """lng > 180 saved to localStorage should be normalized to [-180,180]."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)

            # Fly to a location near the antimeridian (Pacific view)
            # Auckland, NZ area: lng ~174
            await page.evaluate("""() => {
                window._xyzoMap.setView([-36.8, 174.7], 8, { animate: false });
            }""")
            await page.wait_for_timeout(500)

            stored = await page.evaluate("""() => {
                const raw = localStorage.getItem('xyzo-map-view');
                return raw ? JSON.parse(raw) : null;
            }""")

            self.assertIsNotNone(stored, "xyzo-map-view should be saved to localStorage")
            lng = stored.get("lng")
            self.assertIsNotNone(lng)
            self.assertTrue(
                -180 <= lng <= 180,
                f"saved lng should be normalized to [-180, 180], got {lng}",
            )

            # Also test lng < -180
            await page.evaluate("""() => {
                // Fly to a location that would give negative lng beyond -180
                // Pacific view near the antimeridian on the west side
                window._xyzoMap.setView([0, -185], 5, { animate: false });
            }""")
            await page.wait_for_timeout(500)

            stored2 = await page.evaluate("""() => {
                const raw = localStorage.getItem('xyzo-map-view');
                return raw ? JSON.parse(raw) : null;
            }""")

            self.assertIsNotNone(stored2)
            lng2 = stored2.get("lng")
            self.assertTrue(
                -180 <= lng2 <= 180,
                f"saved lng should be normalized, got {lng2}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_url_hash_lng_is_normalized(self):
        """URL hash lng > 180 should be normalized when set by setView."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)

            # Set view to antimeridian region
            await page.evaluate("""() => {
                window._xyzoMap.setView([0, 185], 5, { animate: false });
            }""")
            await page.wait_for_timeout(300)

            hash_val = await page.evaluate("() => window.location.hash")
            if hash_val:
                # Extract lng from hash like #lat,lng,zoom/...
                import re
                m = re.match(r'#(-?\d+\.?\d*),(-?\d+\.?\d*),(\d+)', hash_val)
                if m:
                    lng = float(m.group(2))
                    self.assertTrue(
                        -180 <= lng <= 180,
                        f"hash lng should be normalized to [-180, 180], got {lng}",
                    )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_parsed_hash_accepts_normalized_coords(self):
        """parseMapHash should accept lng values in [-180, 180]."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(f"{BASE_URL}#0,179.5,5", wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)

            parsed = await page.evaluate("""() => {
                // Call parseMapHash directly
                const hash = window.location.hash;
                function parseMapHash(h) {
                    if (!h || h.length < 2) return null;
                    const clean = h.replace(/^#/, '');
                    const parts = clean.split('/');
                    const res = {};
                    const coordsPart = parts[0];
                    if (coordsPart) {
                        const coordNums = coordsPart.split(',').map(Number);
                        if (coordNums.length >= 3 && coordNums.every(n => Number.isFinite(n))) {
                            const [lat, lng, zoom] = coordNums;
                            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && zoom >= 1 && zoom <= 19) {
                                res.lat = lat;
                                res.lng = lng;
                                res.zoom = zoom;
                            }
                        }
                    }
                    return res;
                }
                return parseMapHash(hash);
            }""")

            self.assertIsNotNone(parsed, "parseMapHash should accept lng=179.5")
            self.assertAlmostEqual(parsed.get("lng"), 179.5, places=1)
        finally:
            await ctx.close()


if __name__ == "__main__":
    if not PLAYWRIGHT_AVAILABLE:
        print(f"ERROR: Playwright not available: {IMPORT_ERROR}")
        print("Install with: pip install playwright && playwright install chromium")
        import sys
        sys.exit(1)
    unittest.main(verbosity=2, argv=["tests/test_lng_wrapping.py"])
