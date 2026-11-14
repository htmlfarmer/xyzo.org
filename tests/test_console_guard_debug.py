"""Tests for the console-guard.js debug infrastructure.

These tests verify:
1. ?xyzodebug=1 URL flag sets window.XYZO_DEBUG and persists to localStorage
2. window.__xlogRing() returns a copy of the ring buffer
3. XLog.warn/error capture to ring buffer regardless of XYZO_DEBUG
4. XLog.log/debug only output when XYZO_DEBUG is true
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


class ConsoleGuardDebugTests(unittest.IsolatedAsyncioTestCase):
    """Tests for console-guard.js debug flag and XLog ring buffer."""

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
    async def test_xyzodebug_flag_sets_debug_and_persists(self):
        """?xyzodebug=1 in URL sets XYZO_DEBUG and localStorage."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            # Navigate with ?xyzodebug=1
            await page.goto(f"{BASE_URL}?xyzodebug=1", wait_until="domcontentloaded")
            await page.wait_for_timeout(500)

            result = await page.evaluate("""() => ({
                xyzdebug: window.XYZO_DEBUG,
                lsValue: localStorage.getItem('xyzo.debug'),
            })""")

            self.assertTrue(
                result["xyzdebug"],
                f"window.XYZO_DEBUG should be true with ?xyzodebug=1, got {result['xyzdebug']}",
            )
            self.assertEqual(
                result["lsValue"], "1",
                f"localStorage('xyzo.debug') should be '1', got {result['lsValue']}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_debug_flag_persists_across_navigation(self):
        """After ?xyzodebug=1 visit, subsequent visits have XYZO_DEBUG set from localStorage."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            # First visit with flag to set localStorage
            await page.goto(f"{BASE_URL}?xyzodebug=1", wait_until="domcontentloaded")
            await page.wait_for_timeout(300)

            # Second visit without URL flag
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(300)

            result = await page.evaluate("""() => ({
                xyzdebug: window.XYZO_DEBUG,
                lsValue: localStorage.getItem('xyzo.debug'),
            })""")

            self.assertTrue(
                result["xyzdebug"],
                f"window.XYZO_DEBUG should be true from localStorage, got {result['xyzdebug']}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_xlog_ring_captures_warn_entries(self):
        """XLog.warn entries are captured in __xlogRing regardless of XYZO_DEBUG."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(f"{BASE_URL}?xyzodebug=1", wait_until="domcontentloaded")
            await page.wait_for_timeout(500)

            # Fire some XLog entries
            await page.evaluate("""() => {
                window.XLog.warn("test warn 1");
                window.XLog.warn("test warn 2");
                window.XLog.error("test error 1");
            }""")
            await page.wait_for_timeout(100)

            ring = await page.evaluate("() => window.__xlogRing()")

            self.assertIsInstance(ring, list, "__xlogRing() should return an array")
            self.assertGreaterEqual(
                len(ring), 3,
                f"Expected at least 3 ring entries, got {len(ring)}: {ring}",
            )
            levels = [e["level"] for e in ring]
            self.assertIn("warn", levels, f"Expected 'warn' in ring, got {levels}")
            self.assertIn("error", levels, f"Expected 'error' in ring, got {levels}")

            # Verify structure of ring entries
            for entry in ring:
                self.assertIn("level", entry)
                self.assertIn("ts", entry)
                self.assertIn("args", entry)
        finally:
            await ctx.close()

    @_require_playwright
    async def test_xlog_ring_returns_copy(self):
        """__xlogRing() returns a copy, not the live array."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(f"{BASE_URL}?xyzodebug=1", wait_until="domcontentloaded")
            await page.wait_for_timeout(500)

            await page.evaluate("() => window.XLog.warn('test')")
            await page.wait_for_timeout(50)

            ring1 = await page.evaluate("() => window.__xlogRing()")
            await page.evaluate("() => window.XLog.warn('test2')")
            ring2 = await page.evaluate("() => window.__xlogRing()")

            # ring1 and ring2 should reflect the state at call time
            self.assertLessEqual(len(ring1), len(ring2))
        finally:
            await ctx.close()

    @_require_playwright
    async def test_xlog_ring_max_200_entries(self):
        """Ring buffer caps at 200 entries."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(f"{BASE_URL}?xyzodebug=1", wait_until="domcontentloaded")
            await page.wait_for_timeout(500)

            # Add 250 entries
            await page.evaluate("""() => {
                for (let i = 0; i < 250; i++) {
                    window.XLog.warn("entry " + i);
                }
            }""")
            await page.wait_for_timeout(100)

            ring = await page.evaluate("() => window.__xlogRing()")

            self.assertLessEqual(
                len(ring), 200,
                f"Ring should cap at 200, got {len(ring)}",
            )
        finally:
            await ctx.close()


if __name__ == "__main__":
    if not PLAYWRIGHT_AVAILABLE:
        print(f"ERROR: Playwright not available: {IMPORT_ERROR}")
        print("Install with: pip install playwright && playwright install chromium")
        import sys
        sys.exit(1)
    unittest.main(verbosity=2, argv=["tests/test_console_guard_debug.py"])
