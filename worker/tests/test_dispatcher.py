"""Tests for worker.dispatcher — the stdio JSON-lines IPC loop.

These spawn the dispatcher as a real subprocess and drive it over pipes, so
they exercise the actual wire protocol the Node side speaks. No DB access.

Heartbeat emission is not covered here: it needs a handler that runs longer
than HEARTBEAT_INTERVAL_S, which arrives with `test_noop` in Task 0.10. This
file only asserts that a `heartbeat_check` message is accepted without
crashing the loop.
"""
from __future__ import annotations

import time

import pytest

from worker.tests._helpers import (
    EXIT_TIMEOUT_S,
    READ_TIMEOUT_S,
    DispatcherProc,
)


@pytest.fixture
def dispatcher():
    """A freshly spawned dispatcher. The `ready` line is NOT consumed."""
    d = DispatcherProc()
    try:
        yield d
    finally:
        d.cleanup()


# ── tests ──────────────────────────────────────────────────────────


def test_emits_ready_on_startup_and_exits_on_shutdown(dispatcher: DispatcherProc) -> None:
    msg = dispatcher.read_message()
    assert msg == {"type": "ready", "worker_id": "test-worker"}

    assert dispatcher.shutdown_and_wait() == 0


def test_unknown_message_type_is_ignored(dispatcher: DispatcherProc) -> None:
    dispatcher.expect_ready()

    dispatcher.send({"type": "garbage"})
    # heartbeat_check is a known-but-inert type; it must not crash either.
    dispatcher.send({"type": "heartbeat_check"})

    assert dispatcher.shutdown_and_wait() == 0


def test_malformed_json_is_logged_to_stderr_and_does_not_crash(
    dispatcher: DispatcherProc,
) -> None:
    dispatcher.expect_ready()

    dispatcher.send_raw("not json\n")

    # Still alive and still speaking the protocol afterwards.
    dispatcher.send({"type": "job", "id": "after-garbage", "kind": "nope", "payload": {}})
    msg = dispatcher.read_message()
    assert msg["type"] == "fail"
    assert msg["id"] == "after-garbage"

    assert dispatcher.shutdown_and_wait() == 0

    stderr = dispatcher.stderr()
    assert "IPC parse error" in stderr, stderr
    # The bad line must never have reached stdout.
    assert "not json" in stderr, stderr


def test_unknown_kind_emits_fail(dispatcher: DispatcherProc) -> None:
    dispatcher.expect_ready()

    dispatcher.send(
        {
            "type": "job",
            "id": "fake-job-id",
            "kind": "nonexistent_kind_xyz",
            "payload": {},
        }
    )

    msg = dispatcher.read_message()
    assert msg["type"] == "fail"
    assert msg["id"] == "fake-job-id"
    assert "nonexistent_kind_xyz" in msg["error"]
    assert "unknown kind" in msg["error"]
    assert msg["traceback"] is None
    assert isinstance(msg["ts"], float)

    assert dispatcher.shutdown_and_wait() == 0


def test_cancel_reaches_in_flight_job(dispatcher: DispatcherProc) -> None:
    """Regression test: cancel must short-circuit an in-flight handler.

    Before the worker-thread refactor, the main loop ran the handler
    synchronously, so the `cancel` message sat in stdin until the job had
    already finished — by then `_current_ctx` no longer held the id and
    the cancel was silently dropped as "unknown/finished job".

    With the worker-thread architecture, the main thread stays on stdin,
    flips `ctx.cancelled = True`, and the handler's next
    `ctx.check_cancel()` raises CancelledError — bounded here to ~100ms
    of polling latency.
    """
    dispatcher.expect_ready()

    # 3-second sleep that polls ctx.check_cancel() every ~100ms.
    dispatcher.send(
        {
            "type": "job",
            "id": "cancel-target",
            "kind": "test_sleep",
            "payload": {"sleep": 3},
        }
    )

    # The handler must have started and begun polling before we send
    # cancel — otherwise the cancel races ahead of ctx publication and
    # the test would be measuring the wrong thing.
    started = dispatcher.read_message(timeout=READ_TIMEOUT_S)
    assert started["type"] == "started", started
    assert started["id"] == "cancel-target"

    # Give the worker thread ~150ms to enter the polling loop.
    time.sleep(0.15)

    send_t = time.monotonic()
    dispatcher.send({"type": "cancel", "id": "cancel-target"})

    terminal = dispatcher.read_message(timeout=READ_TIMEOUT_S)
    cancel_latency = time.monotonic() - send_t

    assert terminal["type"] == "cancelled", terminal
    assert terminal["id"] == "cancel-target"
    # If the dispatcher were still running the handler synchronously, this
    # would be ~3s. With the worker-thread fix it must be well under 1s.
    assert cancel_latency < 1.0, (
        f"cancel took {cancel_latency:.3f}s — handler probably ran on the "
        f"main thread so cancel couldn't reach it mid-job"
    )

    assert dispatcher.shutdown_and_wait() == 0


def test_pending_job_is_replaced_and_the_drop_is_logged(
    dispatcher: DispatcherProc,
) -> None:
    """A job arriving mid-flight is queued; a later one replaces it loudly.

    The dispatcher runs one job at a time. While `first` is in flight,
    `second` is parked in `pending`; `third` then overwrites it. That
    silent overwrite was invisible in production, so it now emits a
    "dropping pending job" line on stderr.

    The dropped job produces no terminal event at all — it never started —
    so the stdout stream goes straight from first's `complete` to third's
    `started`.
    """
    dispatcher.expect_ready()

    dispatcher.send(
        {
            "type": "job",
            "id": "first",
            "kind": "test_sleep",
            "payload": {"sleep": 1.5},
        }
    )

    started = dispatcher.read_non_heartbeat()
    assert started["type"] == "started", started
    assert started["id"] == "first"

    # Both arrive while `first` still holds the worker. `second` lands in
    # `pending`, then `third` displaces it.
    dispatcher.send(
        {"type": "job", "id": "second", "kind": "test_sleep", "payload": {"sleep": 0.1}}
    )
    dispatcher.send(
        {"type": "job", "id": "third", "kind": "test_sleep", "payload": {"sleep": 0.1}}
    )

    # `first` runs to completion — queueing never pre-empts it.
    complete_first = dispatcher.read_non_heartbeat()
    assert complete_first["type"] == "complete", complete_first
    assert complete_first["id"] == "first"

    # `third` is the survivor and starts as soon as the slot frees up.
    started_third = dispatcher.read_non_heartbeat()
    assert started_third["type"] == "started", started_third
    assert started_third["id"] == "third", (
        f"expected the newest queued job to run, got {started_third['id']!r} "
        f"(stderr: {dispatcher.stderr()!r})"
    )

    complete_third = dispatcher.read_non_heartbeat()
    assert complete_third["type"] == "complete", complete_third
    assert complete_third["id"] == "third"

    assert dispatcher.shutdown_and_wait() == 0

    stderr = dispatcher.stderr()
    assert "dropping pending job" in stderr, stderr
    assert "second" in stderr, stderr
