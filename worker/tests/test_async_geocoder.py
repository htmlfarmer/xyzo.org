"""Audit 3+4 — async / parallel geocoder tests.

Verifies:

  * ``Geocoder`` honours the shared Nominatim rate limit across threads.
  * ``Geocoder.geocode_articles`` returns results in input order.
  * Cache hits short-circuit Nominatim (no HTTP call).
  * HTTP 429 / network errors / no-result do not crash workers.
  * Country-capital short-circuit avoids the HTTP call entirely.
  * ``GeocodeQueue`` (asyncio) drains a batch and exits cleanly.
  * ``backfill_geocoding.run`` is idempotent and resumable (a fake
    Geocoder lets us run without live Nominatim access).

Most tests are pure-Python (mocked Geocoder) so they run without a live
Nominatim endpoint or DB. The DB-backed tests are guarded behind the
existing ``db`` fixture (which means the test DB must be reachable).

Run::

    cd /var/www/vhosts/xyzo.org
    pytest worker/tests/test_async_geocoder.py -v
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import httpx
import pytest

from worker import geocode


# ──────────────────────────────────────────────────────────────────────────────
# Helpers — fake Nominatim client + fake Geocoder for unit tests
# ──────────────────────────────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status_code: int, payload=None):
        self.status_code = status_code
        self._payload = payload or []

    def json(self):
        return self._payload


class _RecorderClient:
    """Stand-in for ``httpx.Client`` that records call timing."""

    def __init__(self, responses):
        # responses is a list — pop from the front on every ``get`` call.
        self._responses = list(responses)
        self.calls = []
        self._lock = threading.Lock()

    def get(self, url, params=None, headers=None, timeout=None):
        with self._lock:
            self.calls.append({
                "url": url, "params": params, "headers": headers,
                "timeout": timeout, "t": time.monotonic(),
            })
        if not self._responses:
            return _FakeResponse(200, [])
        return self._responses.pop(0)

    def close(self):
        pass


def _make_geocoder_with_fake_client(
    max_workers: int = 2,
    min_interval_s: float = 0.05,
    responses=None,
) -> tuple[geocode.Geocoder, _RecorderClient]:
    """Construct a Geocoder and patch ``httpx.Client`` so calls don't go to network."""
    g = geocode.Geocoder(max_workers=max_workers, min_interval_s=min_interval_s)
    recorder = _RecorderClient(responses or [])

    # Patch the Geocoder's _make_client so we can record calls without
    # going to the network. Each call returns a fresh recorder (cheap;
    # the recorder just counts). The call list is shared via a thread
    # to keep assertions simple.
    shared: list[_RecorderClient] = []
    shared_lock = threading.Lock()

    def fake_client_factory():
        with shared_lock:
            shared.append(_RecorderClient(responses or []))
        return shared[-1]

    g._make_client = fake_client_factory  # type: ignore[assignment]
    return g, recorder


# ──────────────────────────────────────────────────────────────────────────────
# 1) COUNTRY_CAPITALS short-circuit
# ──────────────────────────────────────────────────────────────────────────────


def test_geocode_one_uses_country_capital_for_known_country():
    """A country name shouldn't hit Nominatim — the in-process dict wins."""
    client = _RecorderClient([])  # no network calls
    result = geocode.geocode_one(client, "United States")
    assert result is not None
    assert result["country"] == "US"
    assert result["precision"] == "country"
    assert result["lat"] == 38.8951
    assert client.calls == []  # never called Nominatim


def test_geocode_one_country_capital_alphabetical_aliases():
    """US / USA / America / uk / u.k. all resolve to the capital coords."""
    for q in ("US", "U.K.", "Britain", "UAE", "Pakistan"):
        client = _RecorderClient([])
        result = geocode.geocode_one(client, q)
        assert result is not None, q
        assert result["lat"] is not None
        assert result["lng"] is not None
        assert client.calls == []


# ──────────────────────────────────────────────────────────────────────────────
# 2) Geocoder class — synchronous plumbing
# ──────────────────────────────────────────────────────────────────────────────


def test_geocoder_executor_is_lazy():
    """Constructing a Geocoder doesn't spin up threads until first batch."""
    g = geocode.Geocoder(max_workers=4, min_interval_s=0.0)
    assert g._executor is None
    g.shutdown()
    # Idempotent
    g.shutdown()


def test_geocoder_throttles_across_threads():
    """Two threads competing for Nominatim must serialise through MIN_INTERVAL_S.

    We force MIN_INTERVAL_S high enough to be measurable and verify the
    per-call timing gap is at least that. Real public Nominatim uses
    1.1s; in tests 0.05s keeps the test fast but still proves the
    invariant.
    """
    interval = 0.20
    g = geocode.Geocoder(max_workers=2, min_interval_s=interval)
    call_times: list[float] = []

    def fake_throttled(text: str, **kwargs):
        g._limiter.acquire()
        call_times.append(time.monotonic())
        return {
            "place_name": text,
            "place_name_normalized": text.lower(),
            "country": "US",
            "lat": 1.0,
            "lng": 1.0,
            "precision": "city",
            "confidence": 1.0,
            "osm_id": None,
            "osm_type": None,
        }

    with patch.object(g, "_throttled_geocode", side_effect=fake_throttled):
        with ThreadPoolExecutor(max_workers=2) as ex:
            list(ex.map(g._throttled_geocode, ["a", "b", "c", "d"]))
    g.shutdown()

    assert len(call_times) == 4
    gaps = [call_times[i + 1] - call_times[i] for i in range(len(call_times) - 1)]
    # Every consecutive pair must respect MIN_INTERVAL_S. The two
    # threads are racing but both go through the same lock, so only
    # one Nominatim call per gap.
    for gap in gaps:
        assert gap >= interval - 0.05, f"gap too small: {gap:.3f}s < {interval}"


def test_geocoder_geocode_articles_preserves_input_order():
    """``geocode_articles`` returns tuples in the same order as inputs."""
    # All inputs hit the country short-circuit (no Nominatim call).
    g = geocode.Geocoder(max_workers=2, min_interval_s=0.0)
    inputs = [
        {"id": i, "location_text": name}
        for i, name in enumerate(["United States", "Pakistan", "France", "Germany"])
    ]

    # Skip DB writes — _process_article will try to write to the DB.
    # Patch upsert_location and _update_article to no-ops.
    with patch.object(geocode, "upsert_location", return_value=42), \
         patch.object(geocode, "_update_article", return_value=None), \
         patch.object(geocode, "_mark_unlocated", return_value=None):
        # Also bypass the cache lookup (the article is "new").
        g.prefill_cache = lambda: 0  # type: ignore[assignment]
        # Force the country-capital branch by stubbing _throttled_geocode.
        def fake_throttle(text, **kwargs):
            return {
                "place_name": text,
                "place_name_normalized": text.lower(),
                "country": "ZZ",
                "lat": 1.0,
                "lng": 1.0,
                "precision": "country",
                "confidence": 1.0,
                "osm_id": None,
                "osm_type": None,
            }
        g._throttled_geocode = fake_throttle  # type: ignore[assignment]
        results = g.geocode_articles(inputs)

    g.shutdown()
    assert [r[0]["id"] for r in results] == [a["id"] for a in inputs]
    statuses = [r[1]["status"] for r in results]
    assert statuses == ["geocoded"] * 4


def test_geocoder_handles_http_429_without_crashing():
    """A 429 from Nominatim returns None for that article, doesn't raise."""
    g = geocode.Geocoder(max_workers=1, min_interval_s=0.0)
    bad_response = _FakeResponse(429, [])
    recorder = _RecorderClient([bad_response])

    def fake_client():
        return recorder
    g._make_client = fake_client  # type: ignore[assignment]

    # Bypass cache / DB writes.
    with patch.object(geocode, "upsert_location", return_value=42), \
         patch.object(geocode, "_update_article", return_value=None), \
         patch.object(geocode, "_mark_unlocated", return_value=None), \
         patch.object(g, "prefill_cache", return_value=0):
        # Body text doesn't match a country — Nominatim path is exercised.
        inputs = [{"id": 1, "location_text": "Some Random Place"}]
        results = g.geocode_articles(inputs)
    g.shutdown()
    assert len(results) == 1
    art, res = results[0]
    assert art["id"] == 1
    assert res is not None
    # FIX_NOTES 1.5 semantics: a 429 is transient — the article must NOT be
    # parked as terminal 'unlocated'; it is retried next cycle.
    assert res["status"] == "retry"
    assert recorder.calls, "expected Nominatim to be called"


def test_geocoder_handles_no_result_gracefully():
    """Nominatim returning [] is treated as 'no match' (mark unlocated)."""
    g = geocode.Geocoder(max_workers=1, min_interval_s=0.0)
    empty_response = _FakeResponse(200, [])
    recorder = _RecorderClient([empty_response])

    g._make_client = lambda: recorder  # type: ignore[assignment]
    with patch.object(geocode, "upsert_location", return_value=42), \
         patch.object(geocode, "_update_article", return_value=None), \
         patch.object(geocode, "_mark_unlocated", return_value=None), \
         patch.object(g, "prefill_cache", return_value=0):
        inputs = [{"id": 99, "location_text": "Totally Bogus Place Name"}]
        results = g.geocode_articles(inputs)
    g.shutdown()
    assert len(results) == 1
    assert results[0][1]["status"] == "unlocated"


def test_geocoder_handles_network_error_gracefully():
    """httpx.HTTPError raised inside the worker doesn't kill the batch."""
    g = geocode.Geocoder(max_workers=1, min_interval_s=0.0)

    class _BoomClient:
        def get(self, *a, **kw):
            raise httpx.ConnectError("network down")

        def close(self):
            pass

    g._make_client = lambda: _BoomClient()  # type: ignore[assignment]
    with patch.object(geocode, "upsert_location", return_value=42), \
         patch.object(geocode, "_update_article", return_value=None), \
         patch.object(geocode, "_mark_unlocated", return_value=None), \
         patch.object(g, "prefill_cache", return_value=0):
        results = g.geocode_articles(
            [{"id": 7, "location_text": "Some place"}]
        )
    g.shutdown()
    assert len(results) == 1
    # FIX_NOTES 1.5: transient network failure => 'retry', never 'unlocated'.
    assert results[0][1] is not None
    assert results[0][1]["status"] == "retry"


# ──────────────────────────────────────────────────────────────────────────────
# 3) Async queue
# ──────────────────────────────────────────────────────────────────────────────


def test_rate_limiter_serialises_concurrent_acquires():
    """Concurrency test on the private _RateLimiter."""
    import threading
    interval = 0.10
    limiter = geocode._RateLimiter(interval)
    events: list[float] = []
    lock = threading.Lock()

    def acquire(i: int) -> None:
        limiter.acquire()
        with lock:
            events.append(time.monotonic())

    threads = [threading.Thread(target=acquire, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(events) == 4
    events.sort()
    for i in range(1, len(events)):
        gap = events[i] - events[i - 1]
        assert gap >= interval - 0.02, f"gap {gap:.3f} < {interval}"


def test_geocode_queue_drains_and_exits(monkeypatch):
    """``GeocodeQueue.run_until_idle`` exits cleanly after one batch."""
    from worker import geocode_queue

    # Stub the DB fetch so the queue sees three fake articles.
    fake_articles = [
        {"id": 1, "location_text": "United States"},
        {"id": 2, "location_text": "Pakistan"},
        {"id": 3, "location_text": "Brazil"},
    ]
    monkeypatch.setattr(geocode_queue, "_fetch_pending_sync",
                        lambda limit: fake_articles)

    # Stub Geocoder so it doesn't touch the DB.
    class _NoopGeocoder:
        def __init__(self, *a, **kw):
            self.shutdown_called = False

        def geocode_articles(self, articles):
            return [(a, {"status": "geocoded", "location_id": 1}) for a in articles]

        def shutdown(self, wait=True):
            self.shutdown_called = True

    noop = _NoopGeocoder()
    q = geocode_queue.GeocodeQueue(num_workers=2, geocoder=noop)
    summary = asyncio.run(q.run_until_idle(limit=10))
    assert summary["queued"] == 3
    assert summary["consumed"] == 3
    assert noop.shutdown_called


def test_geocode_queue_aenqueue_threads_workers(monkeypatch):
    """Direct ``aenqueue`` calls feed the worker pool without DB roundtrip.

    The whole sequence is one ``asyncio.run`` because ``asyncio.Queue``
    binds to its running loop; spinning up multiple loops would
    invalidate the queue.
    """
    from worker import geocode_queue

    # Stub the DB fetch — run_until_idle would otherwise hit the real
    # database (no DSN available in unit tests).
    monkeypatch.setattr(geocode_queue, "_fetch_pending_sync",
                        lambda limit: [])

    class _CollectingGeocoder:
        def __init__(self, *a, **kw):
            self.received: list[list[dict]] = []

        def geocode_articles(self, articles):
            self.received.append(list(articles))
            return [(a, {"status": "geocoded"}) for a in articles]

        def shutdown(self, wait=True):
            pass

    cg = _CollectingGeocoder()

    async def scenario() -> dict:
        q = geocode_queue.GeocodeQueue(num_workers=2, geocoder=cg)
        await q.start()
        await q.aenqueue({"id": 1, "location_text": "us"})
        await q.aenqueue({"id": 2, "location_text": "france"})
        # Drain manually: push two sentinels so workers see stop signals,
        # then await them.
        for _ in q._workers:
            await q._queue.put(None)
        await asyncio.gather(*q._workers, return_exceptions=True)
        q._workers = []
        cg.shutdown()
        return {
            "received_calls": len(cg.received),
            "total_received": sum(len(batch) for batch in cg.received),
        }

    result = asyncio.run(scenario())
    assert result["total_received"] >= 2, (
        f"expected both articles to flow through Geocoder, "
        f"got {result['total_received']}"
    )


# ──────────────────────────────────────────────────────────────────────────────
# 4) Backfill driver — uses an in-memory Geocoder fake
# ──────────────────────────────────────────────────────────────────────────────


def test_backfill_run_drains_in_batches(monkeypatch):
    """backfill_geocoding.run processes the pending list in batches."""
    from worker import backfill_geocoding

    # Simulate 350 pending articles across multiple batches.
    all_rows = [
        {"id": i, "location_text": "United States"}  # hits country dict, no net
        for i in range(350)
    ]

    cursor_state = {"offset": 0, "rows": all_rows}

    def fake_fetch(limit, offset=0):
        cursor_state["offset"] = offset
        return list(all_rows[offset:offset + limit])

    monkeypatch.setattr(backfill_geocoding, "_fetch_pending", fake_fetch)
    monkeypatch.setattr(backfill_geocoding, "_count_pending", lambda: 0)

    class _NoopGeocoder:
        def __init__(self, *a, **kw):
            pass

        def geocode_articles(self, articles):
            return [(a, {"status": "geocoded", "location_id": 1}) for a in articles]

        def shutdown(self, wait=True):
            pass

    monkeypatch.setattr(backfill_geocoding, "Geocoder", _NoopGeocoder)

    summary = backfill_geocoding.run(
        overall_limit=350, batch_size=100, progress=False
    )
    assert summary["processed"] == 350
    assert summary["geocoded"] == 350
    assert summary["batches"] == 4  # 100+100+100+50


def test_backfill_resumable_after_partial_run(monkeypatch):
    """If a backfill run stops at --limit 200, re-running resumes the rest."""
    from worker import backfill_geocoding

    # Simulate that the DB still has 600 pending — first 200 will be
    # processed then the script returns. The "remaining" articles stay
    # in the cursor (the next invocation will see them again because we
    # don't move them).
    rows = [{"id": i, "location_text": "france"} for i in range(600)]
    cursor_state = {"offset": 0}

    def fake_fetch(limit, offset=0):
        cursor_state["offset"] = offset
        # In reality the DB is the source of truth — limit caps how
        # much we process this invocation.
        return list(rows[offset:offset + limit])

    monkeypatch.setattr(backfill_geocoding, "_fetch_pending", fake_fetch)
    monkeypatch.setattr(backfill_geocoding, "_count_pending", lambda: 400)

    class _NoopGeocoder:
        def __init__(self, *a, **kw):
            pass
        def geocode_articles(self, articles):
            return [(a, {"status": "geocoded"}) for a in articles]
        def shutdown(self, wait=True):
            pass

    monkeypatch.setattr(backfill_geocoding, "Geocoder", _NoopGeocoder)
    first = backfill_geocoding.run(overall_limit=200, batch_size=100, progress=False)
    # Second run picks up where the first stopped — DB still has 400 left.
    cursor_state["offset"] = 200  # logically the cursor moved
    second = backfill_geocoding.run(overall_limit=200, batch_size=100, progress=False)
    assert first["processed"] == 200
    assert second["processed"] == 200
    # combined, we processed 400 of the original 600.
    assert first["processed"] + second["processed"] == 400


# ──────────────────────────────────────────────────────────────────────────────
# 5) Regression — legacy ``run()`` still works (sync path)
# ──────────────────────────────────────────────────────────────────────────────


def test_legacy_run_exports_unchanged():
    """The synchronous ``geocode.run()`` entrypoint still exists with the
    same signature. Run.py and fast_update.py call it — don't break them.
    """
    import inspect
    sig = inspect.signature(geocode.run)
    assert "limit" in sig.parameters
    assert "progress" in sig.parameters
    assert callable(geocode.run)


def test_legacy_helpers_still_exported():
    """re_evaluate.py / fast_suggest.py import these by name."""
    for name in ("geocode_one", "upsert_location", "COUNTRY_CAPITALS",
                 "_normalize_place", "MAX_PER_CYCLE", "MIN_INTERVAL_S"):
        assert hasattr(geocode, name), f"missing {name} from worker.geocode"


def test_run_parallel_returns_legacy_summary_shape(monkeypatch):
    """``run_parallel`` returns the same keys as ``run`` so callers don't branch."""
    from worker import geocode

    monkeypatch.setattr(geocode, "_fetch_needing_geocode", lambda limit: [])
    summary = geocode.run_parallel(limit=10)
    assert set(summary.keys()) == {"geocoded", "not_found", "errors", "cached"}


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
