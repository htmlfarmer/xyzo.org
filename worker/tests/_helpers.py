"""Shared subprocess driver for worker/tests/*.py.

Lifts ``DispatcherProc`` (and its companion timeout constants) out of
``test_dispatcher.py`` so other test files — e.g. ``test_noop.py`` —
can spawn a dispatcher without duplicating the wire-protocol plumbing.
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
READ_TIMEOUT_S = 5.0
EXIT_TIMEOUT_S = 5.0


class DispatcherProc:
    """Thin driver around a dispatcher subprocess.

    stdout is drained by a reader thread into a queue so reads can time out
    instead of hanging the suite. stderr goes to a temp file so it can be
    inspected after exit without risking a pipe-buffer deadlock.
    """

    def __init__(self, slot_id: str = "test-worker") -> None:
        self.slot_id = slot_id
        self._stderr_file = tempfile.TemporaryFile(mode="w+")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "worker.dispatcher", f"--slot-id={slot_id}"],
            cwd=str(REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_file,
            text=True,
            bufsize=1,  # line buffered
        )
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._reader = threading.Thread(target=self._drain_stdout, daemon=True)
        self._reader.start()

    def _drain_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(line)
        self._lines.put(None)  # EOF sentinel

    # ── sending ────────────────────────────────────────────────────

    def send(self, msg: dict[str, Any]) -> None:
        self.send_raw(json.dumps(msg) + "\n")

    def send_raw(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    # ── receiving ──────────────────────────────────────────────────

    def read_message(self, timeout: float = READ_TIMEOUT_S) -> dict[str, Any]:
        """Read one JSON message from stdout, failing on timeout or EOF."""
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            pytest.fail(f"no IPC message within {timeout}s (stderr: {self.stderr()!r})")
        if line is None:
            pytest.fail(f"dispatcher stdout closed (stderr: {self.stderr()!r})")
        return json.loads(line)

    def expect_ready(self) -> dict[str, Any]:
        msg = self.read_message()
        assert msg["type"] == "ready", f"expected ready, got {msg}"
        return msg

    def read_non_heartbeat(self, timeout: float = READ_TIMEOUT_S) -> dict[str, Any]:
        """Read the next message, skipping heartbeats.

        Heartbeats are timing-dependent noise for tests that only care
        about lifecycle events.
        """
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                pytest.fail(
                    f"no non-heartbeat message within {timeout}s "
                    f"(stderr: {self.stderr()!r})"
                )
            msg = self.read_message(timeout=remaining)
            if msg.get("type") != "heartbeat":
                return msg

    def stderr(self) -> str:
        self._stderr_file.flush()
        self._stderr_file.seek(0)
        return self._stderr_file.read()

    # ── lifecycle ──────────────────────────────────────────────────

    def shutdown_and_wait(self, timeout: float = EXIT_TIMEOUT_S) -> int:
        self.send({"type": "shutdown"})
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            pytest.fail(
                f"dispatcher did not exit within {timeout}s after shutdown "
                f"(stderr: {self.stderr()!r})"
            )

    def cleanup(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=EXIT_TIMEOUT_S)
        for stream in (self.proc.stdin, self.proc.stdout):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
        self._stderr_file.close()


def read_until_terminal(
    dispatcher: DispatcherProc,
    expected_ids: set[str],
    timeout: float = READ_TIMEOUT_S,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Drain non-heartbeat events until a terminal event for any expected id.

    Returns ``(events_seen, terminal)`` where ``events_seen`` is the list of
    progress/log events observed along the way (useful for assertions on
    progress cadence) and ``terminal`` is the closing ``complete`` /
    ``fail`` / ``cancelled`` event.

    Fails the test if no terminal event arrives within ``timeout``.
    """
    events: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail(
                f"no terminal event within {timeout}s (stderr: {dispatcher.stderr()!r})"
            )
        msg = dispatcher.read_non_heartbeat(timeout=remaining)
        if msg.get("type") in ("complete", "fail", "cancelled"):
            if expected_ids and msg.get("id") not in expected_ids:
                pytest.fail(
                    f"unexpected terminal id {msg.get('id')!r}: {msg} "
                    f"(stderr: {dispatcher.stderr()!r})"
                )
            return events, msg
        events.append(msg)
