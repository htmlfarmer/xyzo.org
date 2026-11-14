"""Regression test for the time dropdown + flag button wiring bug.

Tests that the time-dropdown-btn, time-dropdown-menu, and flag-btn
event listeners are attached regardless of whether DOMContentLoaded
fires BEFORE or AFTER app.js executes.

Background:
    app.js is loaded with `defer`, which means it runs after HTML
    parsing but the timing of DOMContentLoaded varies between
    browsers.  If DOMContentLoaded has already fired by the time
    app.js runs (which happens in some browser/CPU combinations),
    an unconditional `document.addEventListener("DOMContentLoaded",
    fn)` will queue the listener forever — the function never
    runs, event listeners never get attached, and the time
    dropdown (and flag button) silently break.

The fix in app.js wraps both wirings in a readyState check:
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
    } else {
      attach();
    }
"""
from __future__ import annotations

import asyncio
import unittest

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
    IMPORT_ERROR = None
except ImportError as e:
    PLAYWRIGHT_AVAILABLE = False
    IMPORT_ERROR = e


import functools
import inspect


def _require_playwright(test_func):
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


BASE_URL = "https://xyzo.org/"


class TimeDropdownWiringTests(unittest.IsolatedAsyncioTestCase):
    """Verify the time dropdown is wired up regardless of DOMContentLoaded timing."""

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
    async def test_time_dropdown_opens_on_click_normal_timing(self):
        """Standard browser timing: clicking the dropdown opens the menu."""
        ctx = await self._browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)
            await page.click("#time-dropdown-btn", timeout=2000)
            await page.wait_for_timeout(300)
            menu_hidden = await page.evaluate(
                "() => document.getElementById('time-dropdown-menu')?.hidden"
            )
            self.assertFalse(menu_hidden, "Menu should be visible after click")
        finally:
            await ctx.close()

    @_require_playwright
    async def test_time_dropdown_opens_when_dl_already_fired(self):
        """DOMContentLoaded already fired before app.js ran — menu still opens."""
        ctx = await self._browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await ctx.new_page()
        try:
            # Force DOMContentLoaded to fire BEFORE app.js's defer script
            # executes.  This is the timing condition that broke the
            # original code.
            await page.add_init_script(
                "document.dispatchEvent(new Event('DOMContentLoaded'));"
            )
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            # Confirm the wiring marker is set (means attach() ran)
            wired = await page.evaluate(
                "() => document.getElementById('time-dropdown-btn')?.dataset.wired"
            )
            self.assertEqual(wired, "1",
                             "time-dropdown-btn should be marked as wired")

            # Click should open the menu
            await page.click("#time-dropdown-btn", timeout=2000)
            await page.wait_for_timeout(300)
            menu_hidden = await page.evaluate(
                "() => document.getElementById('time-dropdown-menu')?.hidden"
            )
            self.assertFalse(menu_hidden, "Menu should be visible after click")
        finally:
            await ctx.close()

    @_require_playwright
    async def test_time_dropdown_options_selectable(self):
        """Clicking a time range button in the menu applies the filter."""
        ctx = await self._browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await ctx.new_page()
        try:
            await page.add_init_script(
                "document.dispatchEvent(new Event('DOMContentLoaded'));"
            )
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            # Open the dropdown via JS click (Playwright's element click
            # fails when the canvas overlays the button)
            await page.evaluate("() => document.getElementById('time-dropdown-btn').click()")
            await page.wait_for_timeout(300)

            # Click the "7 days" option via JS
            await page.evaluate(
                "() => document.querySelector(\"button[data-time='7d']\").click()"
            )
            await page.wait_for_timeout(500)

            # The label should update to "7d"
            label = await page.evaluate(
                "() => document.getElementById('time-dropdown-label')?.textContent"
            )
            self.assertEqual(label, "7d",
                             f"Expected label '7d', got '{label}'")

            # The menu should be hidden after selection
            menu_hidden = await page.evaluate(
                "() => document.getElementById('time-dropdown-menu')?.hidden"
            )
            self.assertTrue(menu_hidden, "Menu should close after selection")
        finally:
            await ctx.close()

    @_require_playwright
    async def test_no_unconditional_domcontentloaded_listener(self):
        """Defensive check: app.js should not contain unconditional
        addEventListener('DOMContentLoaded', ...) calls, because those
        silently break when DOMContentLoaded fires before the script
        runs (which happens in some browsers).

        This is a code-level guard against the bug class returning.
        """
        ctx = await self._browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)

            # Fetch app.js source and check for the anti-pattern.
            src = await page.evaluate(
                """async () => {
                    const r = await fetch('/app.js');
                    return await r.text();
                }"""
            )
            # Look for the bad pattern: an addEventListener for
            # DOMContentLoaded that's NOT preceded by a readyState check
            # AND is actual code (not a comment).
            import re
            bad = []
            for m in re.finditer(r'addEventListener\(["\']DOMContentLoaded["\']', src):
                # Skip if this is inside a single-line comment
                line_start = src.rfind('\n', 0, m.start()) + 1
                line_prefix = src[line_start:m.start()]
                if '//' in line_prefix:
                    continue
                # Skip if this is inside a multi-line comment
                # Look backwards for /* without matching */
                block_start = src.rfind('/*', 0, m.start())
                block_end = src.rfind('*/', 0, m.start())
                if block_start > block_end:
                    continue
                # Check the surrounding context for readyState
                start = max(0, m.start() - 300)
                ctx_window = src[start:m.start()]
                if 'readyState' not in ctx_window:
                    line_no = src[:m.start()].count('\n') + 1
                    bad.append(line_no)
            self.assertEqual(
                bad, [],
                f"Found unconditional DOMContentLoaded listeners at lines {bad}. "
                "These silently break when DOMContentLoaded fires before app.js runs."
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_time_dropdown_shows_counts_in_menu(self):
        """The menu items show count labels like '24 hours (55,214)'."""
        ctx = await self._browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await ctx.new_page()
        try:
            await page.add_init_script(
                "document.dispatchEvent(new Event('DOMContentLoaded'));"
            )
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(4000)

            # Open menu via JS click and read the labels
            await page.evaluate("() => document.getElementById('time-dropdown-btn').click()")
            await page.wait_for_timeout(500)
            labels = await page.evaluate(
                """() => {
                    const items = document.querySelectorAll('#time-dropdown-menu button[data-time]');
                    return Array.from(items).map(b => ({time: b.dataset.time, text: b.textContent}));
                }"""
            )
            self.assertGreater(len(labels), 0, "Menu should have items")
            # At least one item should have a count in parens
            has_count = any("(" in item["text"] and ")" in item["text"] for item in labels)
            self.assertTrue(has_count,
                            f"Expected counts in menu labels, got {labels}")
        finally:
            await ctx.close()


if __name__ == "__main__":
    if not PLAYWRIGHT_AVAILABLE:
        print(f"ERROR: Playwright not available: {IMPORT_ERROR}")
        import sys
        sys.exit(1)
    unittest.main(verbosity=2)
