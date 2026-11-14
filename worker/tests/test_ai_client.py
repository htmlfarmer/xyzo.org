"""Tests for worker.ai_client — Python AI breaker + rate limiter.

Verifies the AIClient dataclass, its three-state circuit breaker
(closed / open / half_open), and the token-bucket rate limiter.
"""
from __future__ import annotations

import time

import pytest

from worker.ai_client import AIClient


def test_loads_config():
    c = AIClient.from_config()
    assert c.base_url.startswith("http")
    assert c.model
    assert c.failure_threshold >= 1


@pytest.mark.asyncio
async def test_breaker_starts_closed():
    c = AIClient.from_config()
    assert c._breaker_allows() is True
    assert c.breaker.state == "closed"


def test_breaker_opens_after_threshold_failures():
    c = AIClient.from_config()
    # failure_threshold defaults to 5
    for _ in range(c.failure_threshold):
        c._breaker_record_failure()
    assert c.breaker.state == "open"
    assert c._breaker_allows() is False


def test_breaker_resets_to_closed_after_success():
    c = AIClient.from_config()
    # Trip the breaker open
    for _ in range(c.failure_threshold):
        c._breaker_record_failure()
    assert c.breaker.state == "open"
    # Record a success — should close the breaker and reset failure_count
    c._breaker_record_success()
    assert c.breaker.state == "closed"
    assert c.breaker.failure_count == 0
    assert c._breaker_allows() is True


def test_breaker_half_open_allows_one_probe():
    c = AIClient.from_config()
    # Trip the breaker open
    for _ in range(c.failure_threshold):
        c._breaker_record_failure()
    assert c.breaker.state == "open"
    # Jump opened_at far enough back so we're past the reset timeout
    c.breaker.opened_at = time.time() - (c.reset_timeout_ms / 1000.0) - 1.0
    # First probe should be allowed and transition us to half_open
    assert c._breaker_allows() is True
    assert c.breaker.state == "half_open"
    # The plan increments half_open_in_flight when a probe is granted.
    # Since half_open_max=1, a second concurrent call must be rejected.
    assert c.breaker.half_open_in_flight < c.half_open_max
    c.breaker.half_open_in_flight += 1  # simulate the probe being "in flight"
    assert c._breaker_allows() is False


@pytest.mark.asyncio
async def test_token_bucket_refills_at_rate():
    # 60/min == 1 token per second
    c = AIClient(rate_limit_per_minute=60, base_url="http://x", model="m")
    # Pre-fill the bucket to capacity and take one token so we know
    # we start with one fewer than the cap.
    c._tokens = float(c.rate_limit_per_minute)
    async with c._lock:
        c._tokens -= 1.0
    assert c._tokens == float(c.rate_limit_per_minute - 1)
    # Manually rewind _last_refill so refill thinks ~1.1s has passed,
    # which should add ~1.1 tokens.
    c._last_refill = time.time() - 1.1
    await c._refill_tokens()
    # Expect roughly cap-1 + 1.1 ≈ cap, capped at rate_limit_per_minute.
    assert c._tokens == pytest.approx(float(c.rate_limit_per_minute), abs=0.01)
