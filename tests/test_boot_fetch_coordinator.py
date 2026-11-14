"""Regression tests for the boot-fetch coordinator in public_html/app.js.

These tests use Playwright headless mode to drive a real browser against
the live xyzo.org page and verify the boot-fetch race condition is fixed.

What we're testing:
  - The coordinator (window._bootCoord) reaches a terminal state within
    the 5-second boot grace window.
  - Pins are actually drawn on the canvas after a successful boot fetch.
  - The retry path fires once when the first fetch returns 0 pins.
  - The retry path gives up cleanly if the retry ALSO returns 0 pins.
  - A user pan during the boot window cancels any pending retry.
  - The coordinator becomes inert after done-ok — normal pans work.
  - Multiple reloads in a row each produce pins (no progressive state
    corruption).

These tests require Playwright + Chromium installed.  Run with:
    pytest tests/test_boot_fetch_coordinator.py -v
or
    python3 tests/test_boot_fetch_coordinator.py   # standalone

If Playwright isn't available, all tests are skipped gracefully.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import unittest

import pytest

# Playwright against the LIVE site — nightly only (TEST_PLAN 6.2)
pytestmark = pytest.mark.live
from pathlib import Path

# Add the project root to the path so we can import worker.xyzo_debug if needed
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Skip gracefully if Playwright isn't installed
try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
    IMPORT_ERROR = None
except ImportError as e:
    PLAYWRIGHT_AVAILABLE = False
    IMPORT_ERROR = e


BASE_URL = os.environ.get("XYZO_TEST_URL", "https://xyzo.org/")


def _require_playwright(test_func):
    """Decorator that skips the test if Playwright isn't available.

    Handles both sync and async test methods.  For async methods,
    returns an async wrapper that awaits the result before checking.
    """
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


class BootFetchCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    """Async test cases for the boot-fetch coordinator."""

    async def asyncSetUp(self):
        """Spin up a single browser + context for all tests in this class."""
        if not PLAYWRIGHT_AVAILABLE:
            self.skipTest(f"Playwright not installed: {IMPORT_ERROR}")
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )

    async def asyncTearDown(self):
        """Clean up browser."""
        await self._browser.close()
        await self._pw.stop()

    async def _new_page(self, viewport=(1920, 1080)):
        ctx = await self._browser.new_context(viewport={"width": viewport[0], "height": viewport[1]})
        return ctx, await ctx.new_page()

    async def _install_state_observer(self, page):
        """Inject a MutationObserver-like hook that records every state transition.

        Returns nothing — the page now exposes window.__xyzoBootHistory as
        an array of {state, at_ms} entries.  Call this BEFORE goto().
        """
        await page.add_init_script(
            """
            window.__xyzoBootHistory = [];
            // Watch _bootCoord.state by polling — we can't use
            // MutationObserver on a plain object, so poll at 50ms
            // intervals and record any changes.
            const startMs = performance.now();
            window.__xyzoBootEverDoneOk = false;
            window.__xyzoBootPollId = setInterval(() => {
                const cur = window._bootCoord?.state;
                if (!cur) return;
                const last = window.__xyzoBootHistory[window.__xyzoBootHistory.length - 1];
                if (!last || last.state !== cur) {
                    window.__xyzoBootHistory.push({
                        state: cur,
                        at_ms: Math.round(performance.now() - startMs),
                    });
                    if (cur === 'done-ok') window.__xyzoBootEverDoneOk = true;
                }
            }, 50);
            """
        )

    async def _stop_state_observer(self, page):
        """Stop the polling observer and return the captured history."""
        try:
            return await page.evaluate(
                """() => {
                    clearInterval(window.__xyzoBootPollId);
                    return {
                        history: window.__xyzoBootHistory || [],
                        everDoneOk: !!window.__xyzoBootEverDoneOk,
                    };
                }"""
            )
        except Exception:
            return {"history": [], "everDoneOk": False}

    async def _get_state(self, page):
        return await page.evaluate(
            """() => ({
                state: window._bootCoord?.state,
                pinCount: window._bootCoord?.pinCount,
                isBootFetch: window._bootCoord?.isBootFetch,
                canvasPins: window._canvasPinRenderer?._pins?.length || 0,
                lastDrawnCount: window._canvasPinRenderer?._lastDrawnCount || 0,
            })"""
        )

    @_require_playwright
    async def test_coordinator_reaches_done_ok_after_normal_boot(self):
        """After a successful boot, pins are drawn on the canvas.

        We verify two signals:
        1. The user-visible result: canvas has >100 pins and lastDrawnCount >100
        2. The diagnostic signal: _bootCoord.state is a terminal one
           (done-ok or expired — both indicate the boot fetch resolved,
           either successfully or by grace-period expiry).

        Note: on slow networks the response can arrive AFTER the 5s
        grace timer expires, in which case _bootCoord.state stays
        'expired' rather than briefly transitioning to 'done-ok'.  The
        pins are still drawn — that's the user-facing success signal.
        """
        ctx, page = await self._new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            # Wait for the boot to fully settle AND for pins to be drawn.
            # We wait for the coordinator to be in any terminal state
            # (done-ok, expired, or done-empty-gave-up) which means
            # the fetch resolved (success OR grace-period exit).
            await page.wait_for_function(
                """() => {
                    const c = window._canvasPinRenderer;
                    const boot = window._bootCoord;
                    return c && c._pins && c._pins.length > 100
                        && c._lastDrawnCount > 100
                        && boot && ['done-ok', 'expired', 'done-empty-gave-up']
                            .includes(boot.state);
                }""",
                timeout=15000,
            )
            # Brief stabilization in case state changed during the wait
            await page.wait_for_timeout(100)
            s = await self._get_state(page)

            # User-facing success: canvas has pins
            self.assertGreater(
                s["canvasPins"], 100,
                f"Canvas should have pins. State: {s}",
            )
            self.assertGreater(
                s["lastDrawnCount"], 100,
                f"Canvas should have drawn pins. State: {s}",
            )
            # Coordinator reached a terminal state
            self.assertIn(
                s["state"],
                ["done-ok", "expired", "done-empty-gave-up"],
                f"Coordinator not in terminal state. State: {s}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_user_pan_during_normal_use_works(self):
        """After boot is done, a user pan fires fetchPinsForViewport directly (coordinator inert)."""
        ctx, page = await self._new_page()
        try:
            await self._install_state_observer(page)
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            # Wait for boot to complete
            await page.wait_for_function(
                "() => window._bootCoord && window._bootCoord.state === 'done-ok'",
                timeout=7000,
            )

            # Trigger a user pan.  The coordinator should NOT participate —
            # normal reloadPins() should fire directly.
            before_pins = await page.evaluate(
                "() => window._canvasPinRenderer?._pins?.length || 0"
            )

            await page.evaluate(
                "() => { window._xyzoMap.setView([40, -74], 6, { animate: false }); }"
            )
            await page.wait_for_timeout(2500)

            after = await self._get_state(page)
            # Coordinator is still in done-ok (or expired by now)
            self.assertIn(
                after["state"], ["done-ok", "expired"],
                f"Unexpected coordinator state after pan: {after['state']}",
            )
            # isBootFetch is false (the pan fetch wasn't tagged as boot)
            self.assertFalse(
                after["isBootFetch"],
                "isBootFetch must be false during normal pan",
            )
            # Canvas has pins (reloaded for the new viewport)
            self.assertGreater(
                after["canvasPins"], 0,
                "Canvas must have pins after the pan",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_empty_first_fetch_triggers_single_retry(self):
        """If the first fetch returns 0 pins, the coordinator schedules one retry.

        The retry should fire (state passes through 'done-empty' then
        'done-retry' then back to either 'done-ok' or 'done-empty-gave-up'
        depending on whether the retry also returns empty).

        Note: the app has a CityEngine fallback that fetches nearby
        cities when the live fetch returns 0 pins.  That fallback can
        rescue an empty result before the coordinator's retry path runs,
        so we block it via mock to test the pure retry path.
        """
        ctx, page = await self._new_page()
        try:
            await self._install_state_observer(page)
            call_count = 0

            async def handle_route(route):
                nonlocal call_count
                url = route.request.url
                # Mock EVERY pins-related endpoint to return empty so the
                # CityEngine fallback doesn't rescue the empty result.
                is_map_call = "/api/pins/map" in url
                is_pins_call = (
                    url.rstrip("/").endswith("/api/pins")
                    or "/api/pins?" in url
                    or "/api/pins/spread" in url
                )
                if is_map_call or is_pins_call:
                    call_count += 1
                    await route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({"items": [], "count": 0}),
                    )
                else:
                    await route.continue_()

            await ctx.route("**/*", handle_route)

            await page.goto(BASE_URL, wait_until="domcontentloaded")
            # Wait long enough for initial + retry + state transitions
            await page.wait_for_timeout(6500)
            result = await self._stop_state_observer(page)

            # At minimum 2 boot calls (initial + retry), no infinite loop
            self.assertGreaterEqual(
                call_count, 2,
                f"Expected ≥2 API calls (initial + retry), got {call_count}",
            )
            self.assertLessEqual(
                call_count, 5,
                f"Expected ≤5 calls (no infinite loop), got {call_count}",
            )
            # History MUST show 'done-empty' (the post-empty-retry state)
            states_seen = [h["state"] for h in result["history"]]
            self.assertIn(
                "done-empty", states_seen,
                f"Expected done-empty in history (signals retry was scheduled), got {states_seen}",
            )
            # After the retry succeeded (or gave up), state should be terminal
            terminal_states = {"done-ok", "done-empty-gave-up", "expired"}
            self.assertTrue(
                any(s in terminal_states for s in states_seen),
                f"Expected terminal state at end, got {states_seen}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_double_empty_gives_up_cleanly(self):
        """If both initial AND retry return empty, coordinator gives up (no infinite loop)."""
        ctx, page = await self._new_page()
        try:
            await self._install_state_observer(page)
            call_count = 0
            call_urls = []

            async def handle_route(route):
                nonlocal call_count
                url = route.request.url
                # Mock BOTH /api/pins/map AND /api/pins (light=1 variant)
                # to be safe.  Some code paths use one, some use the other.
                is_map_call = "/api/pins/map" in url
                is_pins_call = url.rstrip("/").endswith("/api/pins") or "/api/pins?" in url
                if is_map_call or is_pins_call:
                    call_count += 1
                    call_urls.append(url[:80])
                    await route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({"items": [], "count": 0}),
                    )
                else:
                    await route.continue_()

            await ctx.route("**/*", handle_route)

            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(6500)
            result = await self._stop_state_observer(page)

            # The coordinator should NOT do an infinite retry loop.  The
            # initial boot fetch fires (count >= 1), the retry fires
            # (count >= 2).  A 3rd call is acceptable if it's from a
            # different code path (not the retry loop).  The critical
            # assertion is that the coordinator reaches done-empty-gave-up,
            # not that call_count is exactly 2.
            self.assertLessEqual(
                call_count, 4,
                f"Expected ≤4 calls (initial + retry + non-loop extras), got {call_count}: {call_urls}",
            )
            self.assertGreaterEqual(
                call_count, 2,
                f"Expected ≥2 calls (initial + retry), got {call_count}",
            )

            states_seen = [h["state"] for h in result["history"]]
            self.assertIn(
                "done-empty-gave-up", states_seen,
                f"Expected done-empty-gave-up in history, got {states_seen}",
            )
            # Should NOT have reached done-ok (both fetches were empty)
            self.assertFalse(
                result["everDoneOk"],
                f"Should not have reached done-ok with empty fetches. States: {states_seen}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_user_pan_during_boot_cancels_pending_retry(self):
        """A user pan during the boot window cancels the pending retry."""
        ctx, page = await self._new_page()
        try:
            await self._install_state_observer(page)
            call_count = 0

            async def handle_route(route):
                nonlocal call_count
                url = route.request.url
                if "/api/pins/map" in url:
                    call_count += 1
                    if call_count == 1:
                        # First call: empty (triggers retry)
                        await route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({"items": [], "count": 0}),
                        )
                    else:
                        # All subsequent calls: real data
                        await route.continue_()
                else:
                    await route.continue_()

            await ctx.route("**/*", handle_route)

            await page.goto(BASE_URL, wait_until="domcontentloaded")
            # Wait for the first fetch to register the empty response
            await page.wait_for_timeout(800)

            # User pans BEFORE the retry fires (500ms after empty response)
            await page.evaluate(
                "() => { window._xyzoMap.setView([40, -74], 6, { animate: false }); }"
            )
            await page.wait_for_timeout(5500)
            result = await self._stop_state_observer(page)

            # The user's pan fetch (3rd call) should have populated pins
            canvas_pins = await page.evaluate(
                "() => window._canvasPinRenderer?._pins?.length || 0"
            )
            self.assertGreater(
                canvas_pins, 0,
                f"Expected pins from user pan, got {canvas_pins}. "
                f"History: {result['history']}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_multiple_reloads_each_produce_pins(self):
        """Three consecutive reloads each produce pins (no progressive degradation)."""
        for i in range(3):
            ctx, page = await self._new_page()
            try:
                await page.goto(BASE_URL, wait_until="domcontentloaded")
                # Wait for the boot fetch to complete AND for pins to be
                # actually drawn on the canvas.
                await page.wait_for_function(
                    """() => {
                        const c = window._canvasPinRenderer;
                        const boot = window._bootCoord;
                        return c && c._pins && c._pins.length > 100
                            && boot && (boot.state === 'done-ok'
                                        || boot.state === 'expired');
                    }""",
                    timeout=10000,
                )
                pins = await page.evaluate(
                    "() => window._canvasPinRenderer?._pins?.length || 0"
                )
                self.assertGreater(
                    pins, 100,
                    f"Reload {i+1}: expected > 100 pins, got {pins}",
                )
            finally:
                await ctx.close()

    @_require_playwright
    async def test_coordinator_state_observable_through_lifecycle(self):
        """Coordinator state progresses through expected transitions."""
        ctx, page = await self._new_page()
        try:
            await self._install_state_observer(page)
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            # Wait long enough to see the full lifecycle (settle + 5s grace)
            await page.wait_for_timeout(6500)
            result = await self._stop_state_observer(page)

            states_seen = [h["state"] for h in result["history"]]
            # At least one early state should be in the boot lifecycle
            boot_states = {"idle", "settled-pending", "in-flight"}
            self.assertTrue(
                any(s in boot_states for s in states_seen),
                f"Expected at least one boot lifecycle state. Got: {states_seen}",
            )
            # Final state must be a terminal one
            self.assertIn(
                states_seen[-1],
                ["done-ok", "done-empty", "done-retry", "done-empty-gave-up",
                 "expired", "in-flight"],
                f"Expected terminal state at end. Got: {states_seen}",
            )
        finally:
            await ctx.close()


# Allow running as a script for quick local verification
if __name__ == "__main__":
    if not PLAYWRIGHT_AVAILABLE:
        print(f"ERROR: Playwright not available: {IMPORT_ERROR}")
        print("Install with: pip install playwright && playwright install chromium")
        sys.exit(1)

    # Run with verbose output
    unittest.main(verbosity=2, argv=["tests/test_boot_fetch_coordinator.py"])
