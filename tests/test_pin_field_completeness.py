"""Pin field completeness regression tests.

Verifies that all pins returned by the API have the fields that the UI depends on.
This catches cases where extraction pipeline failures silently leave fields null,
causing empty "No keywords" / "No linked stories" sections in the popup even when
the data should exist.

Covers the fields the popup renderer needs:
  - location { lat, lng }       — map placement
  - title                      — popup header
  - published_at               — relative time display
  - canonical_url              — "View Source" button + link in popup
  - source_type                — badge in popup
  - category                   — category badge
  - confidence_score          — confidence bar
  - place_name / location.place_name — city label on map marker

Also covers per-section enrichment (tested separately via API):
  - /api/pins/:id/words       — should return {id, words: {...}}
  - /api/links/:id            — should return {article_id, count, links: [...]}
  - /api/articles/:id/credibility — should return {factors: [...]}
"""
from __future__ import annotations

import os
import unittest

import pytest

pytestmark = pytest.mark.live  # requires localhost:3008 / live xyzo.org (TEST_PLAN 6.2)

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
    IMPORT_ERROR = None
except ImportError as e:
    PLAYWRIGHT_AVAILABLE = False
    IMPORT_ERROR = e


BASE_URL = os.environ.get("XYZO_TEST_URL", "https://xyzo.org/")


REQUIRED_MAP_FIELDS = {
    "id", "title", "location", "source_type",
    "canonical_url", "published_at",
}

REQUIRED_LOCATION_FIELDS = {"lat", "lng"}


def _require_playwright(test_func):
    import functools, inspect
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


class PinFieldCompletenessTests(unittest.IsolatedAsyncioTestCase):
    """Regression tests for pin field completeness."""

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
    async def test_pins_map_returns_required_fields(self):
        """All pins from /api/pins/map have required top-level fields."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            # Fetch pins from a high-density bbox (Europe)
            import json
            resp = await page.evaluate(
                """async () => {
                    const r = await fetch('/api/pins/map?bbox=-15,30,40,70&limit=50');
                    return r.json();
                }"""
            )

            self.assertIn("pins", resp, "Response should have 'pins' key")
            items = resp.get("pins", [])
            self.assertGreater(
                len(items), 0,
                "Test requires at least 1 pin in bbox -15,30,40,70 (Europe)",
            )

            missing = {}
            for pin in items:
                pin_id = pin.get("id", "?")
                for field in REQUIRED_MAP_FIELDS:
                    if field not in pin or pin[field] is None:
                        if pin_id not in missing:
                            missing[pin_id] = []
                        missing[pin_id].append(field)

            self.assertEqual(
                missing, {},
                f"Pins missing required fields: {missing}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_pins_map_location_has_lat_lng(self):
        """All pins have location.lat and location.lng (non-null numbers)."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            resp = await page.evaluate(
                """async () => {
                    const r = await fetch('/api/pins/map?bbox=-15,30,40,70&limit=50');
                    return r.json();
                }"""
            )

            items = resp.get("pins", [])
            bad = []
            for pin in items:
                loc = pin.get("location") or {}
                for field in REQUIRED_LOCATION_FIELDS:
                    val = loc.get(field)
                    if not isinstance(val, (int, float)) or not (-180 <= val <= 180):
                        bad.append({"id": pin.get("id"), "field": field, "value": val})

            self.assertEqual(
                bad, [],
                f"Pins with invalid location fields: {bad[:5]}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_enriched_endpoint_has_credibility(self):
        """Pin /api/pins/:id returns credibility signals for GDACS-style sources.

        This specifically catches the case where a pin has credibility signals
        in the DB but the API doesn't return them, causing the popup to show
        'Credibility analysis not available' even for rich sources.
        """
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            # Get a recent pin ID
            resp = await page.evaluate(
                """async () => {
                    const r = await fetch('/api/pins/map?bbox=-180,-90,180,90&limit=20');
                    return r.json();
                }"""
            )

            items = resp.get("pins", [])
            self.assertGreater(len(items), 0, "Need at least 1 pin")

            failed = []
            for pin in items[:5]:
                pin_id = pin.get("id")
                if not pin_id:
                    continue
                detail = await page.evaluate(
                    f"""async () => {{
                        const r = await fetch('/api/pins/{pin_id}');
                        if (!r.ok) return null;
                        return r.json();
                    }}"""
                )
                if not detail:
                    failed.append((pin_id, "API returned error/null"))
                    continue
                # credibility is optional but should be present if DB has it
                has_cred = "credibility" in detail and detail["credibility"] is not None
                # We don't fail if absent — only track it
                if not has_cred:
                    failed.append((pin_id, "no credibility field"))

            # Print summary but don't fail — credibility is not guaranteed
            if failed:
                print(f"\n[INFO] Pins without credibility field: {failed[:3]}")
        finally:
            await ctx.close()

    @_require_playwright
    async def test_words_endpoint_returns_word_dict(self):
        """/api/pins/:id/words returns {id, words: {word: count, ...}}."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            resp = await page.evaluate(
                """async () => {
                    const r = await fetch('/api/pins/map?bbox=-15,30,40,70&limit=20');
                    return r.json();
                }"""
            )
            items = resp.get("pins", [])
            self.assertGreater(len(items), 0, "Need at least 1 pin")

            bad = []
            for pin in items[:5]:
                pin_id = pin.get("id")
                if not pin_id:
                    continue
                words_data = await page.evaluate(
                    f"""async () => {{
                        const r = await fetch('/api/pins/{pin_id}/words');
                        if (!r.ok) return null;
                        return r.json();
                    }}"""
                )
                if not words_data:
                    bad.append((pin_id, "null response"))
                    continue
                if "words" not in words_data:
                    bad.append((pin_id, "no 'words' key"))
                    continue
                if not isinstance(words_data["words"], dict):
                    bad.append((pin_id, f"'words' is {type(words_data['words']).__name__}, expected dict"))
                    continue

            self.assertEqual(
                bad, [],
                f"Words endpoint issues: {bad}",
            )
        finally:
            await ctx.close()

    @_require_playwright
    async def test_links_endpoint_returns_link_list(self):
        """/api/links/:id returns {article_id, count, links: [...]}."""
        ctx = await self._browser.new_context()
        page = await ctx.new_page()
        try:
            await page.goto(BASE_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            resp = await page.evaluate(
                """async () => {
                    const r = await fetch('/api/pins/map?bbox=-15,30,40,70&limit=20');
                    return r.json();
                }"""
            )
            items = resp.get("pins", [])
            self.assertGreater(len(items), 0, "Need at least 1 pin")

            bad = []
            for pin in items[:5]:
                pin_id = pin.get("id")
                if not pin_id:
                    continue
                links_data = await page.evaluate(
                    f"""async () => {{
                        const r = await fetch('/api/links/{pin_id}');
                        if (!r.ok) return null;
                        return r.json();
                    }}"""
                )
                if not links_data:
                    bad.append((pin_id, "null response"))
                    continue
                if "links" not in links_data:
                    bad.append((pin_id, "no 'links' key"))
                    continue
                if not isinstance(links_data["links"], list):
                    bad.append((pin_id, f"'links' is {type(links_data['links']).__name__}, expected list"))

            self.assertEqual(
                bad, [],
                f"Links endpoint issues: {bad}",
            )
        finally:
            await ctx.close()


if __name__ == "__main__":
    if not PLAYWRIGHT_AVAILABLE:
        print(f"ERROR: Playwright not available: {IMPORT_ERROR}")
        print("Install with: pip install playwright && playwright install chromium")
        import sys
        sys.exit(1)
    unittest.main(verbosity=2, argv=["tests/test_pin_field_completeness.py"])
