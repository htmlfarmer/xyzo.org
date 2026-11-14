"""End-to-end tests for worker.test_noop via the dispatcher subprocess.

Spawns the real ``worker.dispatcher`` and drives it over stdin/stdout to
exercise the synthetic ``test_noop`` handler through the full IPC stack:
handler load → job start → progress emission → terminal event → cancel.

Three paths are covered:

* Success — handler sleeps in chunks, emits progress, returns the payload's
  ``final_result``.
* Failure — ``fail=true`` short-circuits to ``RuntimeError`` and the dispatcher
  emits a ``fail`` event with the configured error string and a traceback.
* Cancellation — a long-running job is interrupted by a ``cancel`` IPC message
  and must acknowledge the cancel in well under 1s (the worker-thread
  responsiveness guarantee from Task 0.9).
"""
from __future__ import annotations

import time

import pytest

from worker.tests._helpers import (
    READ_TIMEOUT_S,
    DispatcherProc,
    read_until_terminal,
)


@pytest.fixture
def dispatcher():
    """A freshly spawned dispatcher. The `ready` line is NOT consumed."""
    d = DispatcherProc()
    try:
        yield d
    finally:
        d.cleanup()


# ── success ─────────────────────────────────────────────────────────


def test_noop_success_emits_progress_and_returns_final_result(
    dispatcher: DispatcherProc,
) -> None:
    dispatcher.expect_ready()

    dispatcher.send(
        {
            "type": "job",
            "id": "j1",
            "kind": "test_noop",
            "payload": {
                "sleep_ms": 150,
                "progress_every_ms": 50,
                "final_result": {"hello": "world"},
            },
        }
    )

    started = dispatcher.read_non_heartbeat()
    assert started["type"] == "started"
    assert started["id"] == "j1"

    # The handler sleeps 150ms in 50ms chunks, so we expect ~3 progress
    # events. Allow 1–4 to absorb scheduler jitter without making the
    # assertion a no-op.
    events, terminal = read_until_terminal(dispatcher, expected_ids={"j1"})

    assert terminal["type"] == "complete", terminal
    assert terminal["id"] == "j1"
    assert terminal["result"] == {"hello": "world"}

    progress_events = [e for e in events if e.get("type") == "progress"]
    assert 1 <= len(progress_events) <= 4, (
        f"expected 1-4 progress events for 150ms/50ms, got {len(progress_events)}: "
        f"{progress_events}"
    )

    # First event must advertise forward motion, never silent.
    assert progress_events[0]["id"] == "j1"
    assert progress_events[0]["step"] == "working"
    assert isinstance(progress_events[0]["pct"], (int, float))
    # state is a flat dict the server stores verbatim in jobs.state.
    assert isinstance(progress_events[0]["state"], dict)
    assert progress_events[0]["state"].get("step") == "working"
    assert "progress" in progress_events[0]["state"]

    # No failure / cancellation events should have leaked into the stream.
    assert not any(e.get("type") in ("fail", "cancelled") for e in events)

    assert dispatcher.shutdown_and_wait() == 0


# ── failure ─────────────────────────────────────────────────────────


def test_noop_failure_emits_fail_with_error_and_traceback(
    dispatcher: DispatcherProc,
) -> None:
    dispatcher.expect_ready()

    dispatcher.send(
        {
            "type": "job",
            "id": "j2",
            "kind": "test_noop",
            "payload": {
                "sleep_ms": 50,
                "progress_every_ms": 0,  # silent: no progress events
                "fail": True,
                "error": "synthetic error",
            },
        }
    )

    started = dispatcher.read_non_heartbeat()
    assert started["type"] == "started"
    assert started["id"] == "j2"

    events, terminal = read_until_terminal(dispatcher, expected_ids={"j2"})

    assert terminal["type"] == "fail", terminal
    assert terminal["id"] == "j2"
    assert terminal["error"] == "synthetic error"
    # The dispatcher attaches a formatted traceback for handler exceptions.
    assert isinstance(terminal.get("traceback"), str)
    assert "RuntimeError" in terminal["traceback"]

    # progress_every_ms=0 must suppress progress events entirely.
    assert not any(e.get("type") == "progress" for e in events)

    assert dispatcher.shutdown_and_wait() == 0


# ── cancellation ────────────────────────────────────────────────────


def test_noop_cancel_reaches_in_flight_job_quickly(
    dispatcher: DispatcherProc,
) -> None:
    """The whole point of test_noop: prove cancel is prompt.

    The handler sleeps 2s in 50ms chunks. After we confirm it has entered
    the polling loop, a cancel must reach it on the next checkpoint — well
    under the 1s upper bound the dispatcher imposes.
    """
    dispatcher.expect_ready()

    dispatcher.send(
        {
            "type": "job",
            "id": "j3",
            "kind": "test_noop",
            "payload": {"sleep_ms": 2000, "progress_every_ms": 50},
        }
    )

    started = dispatcher.read_non_heartbeat()
    assert started["type"] == "started"
    assert started["id"] == "j3"

    # Give the worker thread ~100ms to enter the polling loop. Without this
    # delay we'd risk racing cancel ahead of ctx publication and measuring
    # the wrong thing.
    time.sleep(0.1)

    send_t = time.monotonic()
    dispatcher.send({"type": "cancel", "id": "j3"})

    # Drain everything until the terminal `cancelled` event arrives.
    # The handler may have emitted one or more progress events before the
    # next check_cancel() call, so don't assume the next message IS the
    # terminal.
    deadline = time.monotonic() + READ_TIMEOUT_S
    terminal = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail(
                f"no terminal event within {READ_TIMEOUT_S}s "
                f"(stderr: {dispatcher.stderr()!r})"
            )
        msg = dispatcher.read_non_heartbeat(timeout=remaining)
        if msg.get("type") in ("complete", "fail", "cancelled"):
            terminal = msg
            break

    cancel_latency = time.monotonic() - send_t

    assert terminal["type"] == "cancelled", terminal
    assert terminal["id"] == "j3"
    # If the dispatcher were still running the handler on the main thread,
    # cancel would sit in stdin until the 2s sleep finished. With the
    # worker-thread architecture, cancel must reach the next check_cancel()
    # checkpoint — within ~50ms of polling plus the cancel-detection lag.
    assert cancel_latency < 1.0, (
        f"cancel took {cancel_latency:.3f}s — handler probably ran on the "
        f"main thread so cancel couldn't reach it mid-job"
    )

    assert dispatcher.shutdown_and_wait() == 0
