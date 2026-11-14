# worker/ai_client.py
"""Python mirror of api/src/ai-breaker.ts. Single source of config truth
is worker/ai_config.json. Two implementations (TS and Python) is a known
cost; extract to a sidecar if drift becomes a problem.

Routing policy (configurable via ai_config.json):
- `primary_base_url` (hivv.org by default) handles all AI calls.
- On retryable failures (502/503/504, timeout, connection error), the client
  falls back to `fallback_base_url` (the local Gemma box directly) and
  emits a WARN log so operators see degradation.
- The primary is retried after `fallback.cooldown_seconds` so we don't
  hammer a dead hivv.org.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


_CONFIG_PATH = Path(__file__).parent / "ai_config.json"
log = logging.getLogger("newsium.ai_client")


@dataclass
class BreakerState:
    state: str = "closed"  # closed | open | half_open
    failure_count: int = 0
    opened_at: float = 0.0
    half_open_in_flight: int = 0


@dataclass
class AIClient:
    primary_base_url: str
    fallback_base_url: str | None
    model: str
    rate_limit_per_minute: int
    extra_headers: dict[str, str] = field(default_factory=dict)
    breaker: BreakerState = field(default_factory=BreakerState)
    failure_threshold: int = 5
    reset_timeout_ms: int = 30_000
    half_open_max: int = 1
    fallback_cooldown_seconds: int = 30
    warn_on_fallback: bool = True
    _tokens: float = 0.0
    _last_refill: float = field(default_factory=time.time)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _next_primary_attempt: float = 0.0

    @classmethod
    def from_config(cls) -> "AIClient":
        cfg = json.loads(_CONFIG_PATH.read_text())
        b = cfg["breaker"]
        # New config shape: primary_base_url + fallback_base_url.
        # Old shape: base_url only — treat it as the fallback so we
        # preserve behavior when the config hasn't been migrated yet.
        primary = cfg.get("primary_base_url")
        fallback = cfg.get("fallback_base_url") or cfg.get("base_url")
        if not primary:
            primary = fallback
            fallback = None
        fb = cfg.get("fallback") or {}
        return cls(
            primary_base_url=primary,
            fallback_base_url=fallback,
            model=cfg["model"],
            rate_limit_per_minute=cfg["rate_limit_per_minute"],
            extra_headers=cfg.get("extra_headers", {}),
            failure_threshold=b["failure_threshold"],
            reset_timeout_ms=b["reset_timeout_ms"],
            half_open_max=b["half_open_max"],
            fallback_cooldown_seconds=fb.get("cooldown_seconds", 30),
            warn_on_fallback=fb.get("warn_on_fallback", True),
        )

    async def _refill_tokens(self) -> None:
        now = time.time()
        elapsed = now - self._last_refill
        self._tokens = min(self.rate_limit_per_minute, self._tokens + elapsed * (self.rate_limit_per_minute / 60.0))
        self._last_refill = now

    async def _take_token(self) -> None:
        async with self._lock:
            while self._tokens < 1.0:
                await self._refill_tokens()
                if self._tokens < 1.0:
                    await asyncio.sleep(0.1)
            self._tokens -= 1.0

    def _breaker_allows(self) -> bool:
        s = self.breaker.state
        if s == "closed":
            return True
        if s == "open":
            if time.time() - self.breaker.opened_at > self.reset_timeout_ms / 1000.0:
                self.breaker.state = "half_open"
                self.breaker.half_open_in_flight = 0
                return True
            return False
        if s == "half_open":
            return self.breaker.half_open_in_flight < self.half_open_max
        return False

    def _breaker_record_success(self) -> None:
        self.breaker.state = "closed"
        self.breaker.failure_count = 0

    def _breaker_record_failure(self) -> None:
        self.breaker.failure_count += 1
        if self.breaker.failure_count >= self.failure_threshold:
            self.breaker.state = "open"
            self.breaker.opened_at = time.time()

    def _should_fallback(self, exc: Exception) -> bool:
        """Decide whether the error is the kind that warrants falling back
        from hivv.org to the local box."""
        if isinstance(exc, httpx.TimeoutException):
            return True
        if isinstance(exc, httpx.ConnectError):
            return True
        if isinstance(exc, httpx.HTTPStatusError):
            return exc.response.status_code in (502, 503, 504)
        return False

    async def _try_endpoint(
        self, base_url: str, messages: list[dict], kwargs: dict[str, Any]
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{base_url}/v1/chat/completions",
                json={"model": self.model, "messages": messages, **kwargs},
                headers=self.extra_headers,
            )
            resp.raise_for_status()
            return resp.json()

    async def _try_endpoint_stream(
        self, base_url: str, messages: list[dict], kwargs: dict[str, Any]
    ):
        """Yield SSE `data: {...}` lines from the upstream, falling back from
        primary to fallback the same way `chat()` does. Yields raw text lines
        so the caller can parse OpenAI delta chunks however it likes."""
        kwargs = {**kwargs, "stream": True}
        primary_allowed = time.time() >= self._next_primary_attempt
        try_primary = bool(self.primary_base_url) and primary_allowed

        primary_error: Exception | None = None
        if try_primary:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=5.0, read=300.0, write=10.0)) as client:
                    async with client.stream(
                        "POST",
                        f"{self.primary_base_url}/v1/chat/completions",
                        json={"model": self.model, "messages": messages, **kwargs},
                        headers=self.extra_headers,
                    ) as resp:
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            yield line
                return
            except Exception as err:
                primary_error = err
                self._breaker_record_failure()
                if not self._should_fallback(err):
                    raise
                self._next_primary_attempt = time.time() + self.fallback_cooldown_seconds

        if not self.fallback_base_url:
            if primary_error:
                raise primary_error
            raise RuntimeError("No AI endpoint available (no fallback configured)")

        if self.warn_on_fallback:
            log.warning(
                "AI primary (%s) unavailable (%s) — falling back to direct local at %s for stream. "
                "Primary will be retried in %ss.",
                self.primary_base_url or "<none>",
                primary_error.__class__.__name__ if primary_error else "cooldown",
                self.fallback_base_url,
                self.fallback_cooldown_seconds,
            )

        # The llama.cpp box at 192.168.1.3 returns 500 on streaming requests,
        # so when we fall back we have to buffer the non-streaming response and
        # re-emit it as a single chunk to keep the caller's streaming interface.
        # If the caller asked for streaming, override; if not, behave normally.
        fallback_kwargs = dict(kwargs)
        if fallback_kwargs.get("stream", True):
            fallback_kwargs["stream"] = False

        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=5.0, read=300.0, write=10.0)) as client:
            resp = await client.post(
                f"{self.fallback_base_url}/v1/chat/completions",
                json={"model": self.model, "messages": messages, **fallback_kwargs},
            )
            resp.raise_for_status()
            data = resp.json()
            # Re-emit as a single OpenAI delta-style chunk so SSE consumers
            # still get a well-formed payload, then the [DONE] sentinel.
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "") or ""
            yield 'data: ' + json.dumps({
                "id": data.get("id", "fallback"),
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": "stop"}]
            })
            yield "data: [DONE]"

    async def chat(self, messages: list[dict], **kwargs) -> dict[str, Any]:
        if not self._breaker_allows():
            raise RuntimeError("AI breaker open")
        await self._take_token()

        # Skip primary for `cooldown_seconds` after a fallback so we don't
        # hammer a dead hivv.org. The cooldown unlocks on its own; success
        # on primary resets the cooldown.
        primary_allowed = time.time() >= self._next_primary_attempt
        try_primary = bool(self.primary_base_url) and primary_allowed

        primary_error: Exception | None = None
        if try_primary:
            try:
                result = await self._try_endpoint(self.primary_base_url, messages, kwargs)
                self._breaker_record_success()
                return result
            except Exception as err:
                primary_error = err
                self._breaker_record_failure()
                if not self._should_fallback(err):
                    # Hard error (bad request, etc.) — don't degrade, surface it.
                    raise
                # Mark primary as cold so the next call short-circuits to fallback
                # for `cooldown_seconds`.
                self._next_primary_attempt = time.time() + self.fallback_cooldown_seconds

        # Fallback path: local Gemma box. Always reachable when on the same LAN.
        if not self.fallback_base_url:
            if primary_error:
                raise primary_error
            raise RuntimeError("No AI endpoint available (no fallback configured)")

        if self.warn_on_fallback:
            log.warning(
                "AI primary (%s) unavailable (%s) — falling back to direct local at %s. "
                "Primary will be retried in %ss.",
                self.primary_base_url or "<none>",
                primary_error.__class__.__name__ if primary_error else "cooldown",
                self.fallback_base_url,
                self.fallback_cooldown_seconds,
            )

        try:
            result = await self._try_endpoint(self.fallback_base_url, messages, kwargs)
            self._breaker_record_success()
            return result
        except Exception:
            self._breaker_record_failure()
            raise

    async def chat_stream(self, messages: list[dict], **kwargs):
        """Async generator that yields raw SSE `data:` lines from the upstream
        (with the `data: ` prefix stripped). Same primary→fallback routing as
        `chat()`. The caller is responsible for parsing the OpenAI delta chunks
        and assembling the final assistant message."""
        if not self._breaker_allows():
            raise RuntimeError("AI breaker open")
        await self._take_token()
        saw_any = False
        try:
            async for line in self._try_endpoint_stream(
                # base_url unused — _try_endpoint_stream handles primary/fallback itself
                self.primary_base_url, messages, kwargs
            ):
                saw_any = True
                yield line
        except Exception:
            self._breaker_record_failure()
            raise
        # Only count a success if we actually streamed at least one line.
        # A stream that errors out before sending anything is a failure.
        if saw_any:
            self._breaker_record_success()


# Module-level singleton, lazily initialized
_client: AIClient | None = None


def get_ai_client() -> AIClient:
    global _client
    if _client is None:
        _client = AIClient.from_config()
    return _client


async def ai_chat(messages: list[dict], **kwargs) -> dict[str, Any]:
    return await get_ai_client().chat(messages, **kwargs)


async def ai_chat_stream(messages: list[dict], **kwargs):
    """Stream an OpenAI-compatible chat completion through the primary
    (hivv.org) → fallback (direct local) chain. Async generator yielding raw
    SSE `data:` lines with the `data: ` prefix stripped. Yields `[DONE]`
    sentinel as the last line on success."""
    async for line in get_ai_client().chat_stream(messages, **kwargs):
        # The upstream always sends `data: <json>\n\n`; strip the prefix and
        # pass the payload through. `[DONE]` is the terminal sentinel.
        if line.startswith("data: "):
            payload = line[len("data: "):].strip()
            if payload:
                yield payload
        elif line.strip():
            # Comment lines (`:ok`) and other SSE cruft — ignore.
            pass
