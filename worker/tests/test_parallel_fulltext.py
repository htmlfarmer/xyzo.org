"""Tests for the parallel fulltext fetcher (Audit 4 #26).

Covers:
  * Parallel speedup vs sequential: 20 articles × 0.5 s each should
    finish well under 10 s when run with 16-way concurrency.
  * Per-host politeness: same-host fetches are spaced by per_host_delay_ms.
  * Batch resilience: a single failure does not crash the batch.
  * Blacklist: localhost / 127.0.0.1 are skipped.
  * Missing URL / bad URL: surfaced as {error: ...}, no exception.

The HTTP layer is mocked via ``monkeypatch`` on
``httpx.AsyncClient.get`` so tests are hermetic — no real network.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import MagicMock

import pytest


# ── helpers ─────────────────────────────────────────────────────────────


def _make_html_resp(html: str = "<html><body><p>hello world</p></body></html") -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"content-type": "text/html; charset=utf-8"}
    resp.text = html
    return resp


@pytest.fixture
def stub_extraction(monkeypatch):
    """Replace extract_from_html so we don't depend on the real HTMLParser path."""
    def _fake(html: str, base_url: str = "") -> dict:
        return {
            "title": "stub-title",
            "content": "stub content " * 30,  # > 200 chars to pass update gate
            "description": "stub desc",
            "content_length": 360,
            "image_url": None,
        }
    monkeypatch.setattr("worker.fulltext.extract_from_html", _fake)


@pytest.fixture
def stub_sleep(monkeypatch):
    """No-op asyncio.sleep so per-host tests run fast.

    Tests that care about real timing (test_per_host_rate_limit_holds)
    bypass this fixture and let sleep run; they pick small delay values
    that finish in <1 s.
    """
    async def _noop(_seconds: float) -> None:
        return None
    monkeypatch.setattr("worker.fulltext.asyncio.sleep", _noop)


# ── tests ────────────────────────────────────────────────────────────────


def test_parallel_faster_than_sequential(monkeypatch, stub_extraction, stub_sleep):
    """20 fetches at 0.5 s each should run well under the 10 s sequential baseline."""
    # Mock httpx.AsyncClient.get to simulate a 0.5 s HTTP call
    delay_s = 0.5

    async def mock_get(self, url, **kwargs):  # noqa: ARG001
        await asyncio.sleep(delay_s)
        return _make_html_resp()

    monkeypatch.setattr("httpx.AsyncClient.get", mock_get)

    from worker.fulltext import FulltextFetcher

    # Spread 20 articles across ~7 hosts so concurrency can actually fire
    articles = [
        {"id": i, "url": f"http://host{i // 3}.example.com/article-{i}"}
        for i in range(20)
    ]

    fetcher = FulltextFetcher(max_concurrent=16, per_host_delay_ms=0)
    start = time.time()
    results = fetcher.fetch_batch_sync(articles)
    elapsed = time.time() - start

    assert len(results) == 20, f"expected 20 results, got {len(results)}"
    assert all(r.get("error") is None for r in results), \
        f"unexpected errors: {[r.get('error') for r in results if r.get('error')]}"
    # Sequential baseline: 20 × 0.5 s = 10 s. With 16 concurrent + spread
    # hosts, we expect ~2 s wall-clock. Generous bound to avoid flake.
    assert elapsed < 4.0, f"parallel fetch took {elapsed:.2f}s — expected < 4s"


def test_per_host_rate_limit_holds(monkeypatch, stub_extraction):
    """Same-host fetches are spaced by per_host_delay_ms.

    We disable the stub_sleep fixture so asyncio.sleep runs for real,
    but pick small values so the test still finishes in well under 1 s.
    """
    http_delay_s = 0.02
    per_host_delay_ms = 150

    async def mock_get(self, url, **kwargs):  # noqa: ARG001
        await asyncio.sleep(http_delay_s)
        return _make_html_resp()

    monkeypatch.setattr("httpx.AsyncClient.get", mock_get)

    from worker.fulltext import FulltextFetcher

    # 5 articles all on the same host → strictly serial, spaced by floor
    articles = [
        {"id": i, "url": f"http://same.example.com/a-{i}"}
        for i in range(5)
    ]

    fetcher = FulltextFetcher(
        max_concurrent=16,
        per_host_delay_ms=per_host_delay_ms,
    )
    start = time.time()
    results = fetcher.fetch_batch_sync(articles)
    elapsed = time.time() - start

    assert len(results) == 5
    assert all(r.get("error") is None for r in results)

    # 5 × http_delay + 4 × per_host_delay gaps = 5×0.02 + 4×0.15 = 0.70 s
    expected_min = (5 * http_delay_s) + (4 * per_host_delay_ms / 1000.0)
    # Allow 30 % slack for scheduler jitter — still proves the gap exists
    assert elapsed >= expected_min * 0.7, (
        f"per-host floor not enforced: {elapsed:.2f}s < {expected_min:.2f}s "
        f"(expected at least {expected_min:.2f}s)"
    )


def test_per_host_serialised_with_concurrency(monkeypatch, stub_extraction, stub_sleep):
    """Even with high global concurrency, same-host fetches never overlap."""
    overlap_detected = {"count": 0}
    in_flight = {"n": 0}
    lock = asyncio.Lock()

    async def mock_get(self, url, **kwargs):  # noqa: ARG001
        async with lock:
            in_flight["n"] += 1
            if in_flight["n"] > 1:
                overlap_detected["count"] += 1
        try:
            await asyncio.sleep(0.05)
            return _make_html_resp()
        finally:
            async with lock:
                in_flight["n"] -= 1

    monkeypatch.setattr("httpx.AsyncClient.get", mock_get)

    from worker.fulltext import FulltextFetcher

    # 10 articles on the SAME host, but global cap is 16 → without the
    # per-host lock the scheduler would happily run them all at once.
    articles = [
        {"id": i, "url": f"http://one.example.com/a-{i}"}
        for i in range(10)
    ]

    fetcher = FulltextFetcher(max_concurrent=16, per_host_delay_ms=0)
    results = fetcher.fetch_batch_sync(articles)

    assert len(results) == 10
    assert overlap_detected["count"] == 0, (
        f"saw {overlap_detected['count']} same-host overlaps — per-host "
        f"lock is broken"
    )


def test_failed_fetch_doesnt_crash_batch(monkeypatch, stub_extraction, stub_sleep):
    """A single network failure must not abort the whole batch."""
    async def mock_get(self, url, **kwargs):  # noqa: ARG001
        if "fail" in url:
            raise RuntimeError("simulated network failure")
        return _make_html_resp()

    monkeypatch.setattr("httpx.AsyncClient.get", mock_get)

    from worker.fulltext import FulltextFetcher

    articles = [
        {"id": 1, "url": "http://a.example.com/1"},
        {"id": 2, "url": "http://b.example.com/fail-1"},
        {"id": 3, "url": "http://c.example.com/3"},
        {"id": 4, "url": "http://d.example.com/fail-2"},
        {"id": 5, "url": "http://e.example.com/5"},
    ]

    fetcher = FulltextFetcher(max_concurrent=16, per_host_delay_ms=0)
    results = fetcher.fetch_batch_sync(articles)

    assert len(results) == 5
    failures = [r for r in results if r.get("error")]
    successes = [r for r in results if not r.get("error")]
    assert len(failures) == 2, f"expected 2 failures, got {len(failures)}"
    assert len(successes) == 3, f"expected 3 successes, got {len(successes)}"
    # Every failure has an error string, every success has content
    assert all(f.get("error") for f in failures)
    assert all(s.get("content") for s in successes)


def test_blacklist_skips_loopback(stub_extraction, stub_sleep):
    """Localhost / 127.0.0.1 must never actually fire an HTTP request."""
    from worker.fulltext import FulltextFetcher

    def must_not_call(*_a, **_kw):
        raise AssertionError("blacklisted host should not be fetched")

    # We don't even install a mock — the blacklist check fires before
    # the network layer is reached.
    fetcher = FulltextFetcher(max_concurrent=16, per_host_delay_ms=0)
    results = fetcher.fetch_batch_sync([
        {"id": 1, "url": "http://localhost:8000/admin"},
        {"id": 2, "url": "http://127.0.0.1:5000/internal"},
        {"id": 3, "url": "http://0.0.0.0/x"},
    ])

    assert len(results) == 3
    assert all(r.get("error", "").startswith("blacklisted_host") for r in results), \
        f"expected blacklisted_host errors, got: {[r.get('error') for r in results]}"


def test_missing_url_surfaced_as_error(stub_extraction, stub_sleep):
    """Article without a URL must not crash — return error dict."""
    from worker.fulltext import FulltextFetcher

    fetcher = FulltextFetcher(max_concurrent=16, per_host_delay_ms=0)
    results = fetcher.fetch_batch_sync([
        {"id": 1, "url": ""},
        {"id": 2},  # no url key at all
    ])

    assert len(results) == 2
    assert all(r.get("error") == "missing_url" for r in results)


def test_extract_host_lowercases_and_strips_port():
    """URL host extraction is case-insensitive and ignores port."""
    from worker.fulltext import FulltextFetcher

    assert FulltextFetcher._extract_host("HTTP://Example.COM:8080/x") == "example.com"
    assert FulltextFetcher._extract_host("https://news.example.org/path") == "news.example.org"
    assert FulltextFetcher._extract_host("not-a-url") == ""
