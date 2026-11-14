"""stdio JSON-lines loop between the Node API and a Python worker process.

Reads ``{"type": ...}`` messages from stdin, dispatches them to handler
modules loaded lazily on first use, and streams progress / log / terminal
events back on stdout. A heartbeat is emitted every 2s while a job is in
flight.

Wire format is one JSON object per line, matching the TypeScript types in
``api/src/queue/ipcProtocol.ts``. Timestamps are Unix epoch floats.

IMPORTANT: stdout is the IPC channel. Any diagnostic output from this
module or from a handler MUST go to stderr (``print(..., file=sys.stderr)``)
or it will corrupt the stream and the Node side will raise IpcParseError.

Threading model
---------------
Three threads while idle, four while a job is in flight:

  Main thread   — pulls messages off ``msg_queue``, drives the dispatcher
                  state machine (start / cancel / shutdown) and enforces
                  the single-job-per-worker invariant.
  Reader thread — reads stdin one line at a time, parses it, and puts the
                  decoded dict on ``msg_queue``. Decoupled from main so a
                  `cancel` or `shutdown` can race in while a handler is
                  mid-flight instead of sitting unread in the pipe.
  Worker thread — spawned per job by ``_start_job``. Publishes its
                  ``JobContext`` into ``_current_ctx`` BEFORE the handler
                  runs (so a racing cancel can find it) and pops it in
                  ``finally``. Emits the terminal event.
  Heartbeat     — daemon thread per job, emits a heartbeat every
                  HEARTBEAT_INTERVAL_S until the worker thread sets its
                  stop event.

Single-job-per-worker invariant: main never starts a second job while
``in_flight`` is unset. A `job` arriving mid-flight is held in ``pending``
(only the newest is kept) and started when the current job finishes.

Usage:
    python -m worker.dispatcher --slot-id=<slot>
"""
from __future__ import annotations

import importlib
import json
import os
import queue
import sys
import threading
import time
import traceback
from typing import Any, Callable

# Lazy-loaded handler registry: kind -> (module_path, function_name).
# Modules are top-level members of the `worker` package (this codebase has no
# `worker/handlers/` subpackage). A module that does not exist yet, or that
# does not export `run`, surfaces as a normal `fail` event at dispatch time.
HANDLERS: dict[str, tuple[str, str]] = {
    # explore_region has a thin ctx-aware adapter at worker/handlers/explore_region
    # that wraps the legacy worker/explore_region.py orchestrator. Other handlers
    # still expose run() directly on their worker/<module>.py module.
    "explore_region": ("worker.handlers.explore_region", "run"),
    # Thin ctx-aware adapter at worker/handlers/sources_audit dispatches
    # on payload['op'] to three helpers — worker.source_discovery
    # (sync), worker.density.auto_correct_density (async), and
    # worker.relocate.relocate_batch (async). Replaces the inline
    # spawns at api/src/routes/sources.ts (~243, ~491, ~558).
    "sources_audit": ("worker.handlers.sources_audit", "run"),
    # Thin ctx-aware adapter at worker/handlers/links_generate wraps the
    # legacy worker.links.detect_links_batch (mirrors the feedback_suggest
    # pattern). Replaces the inline `python3 -c "<code>"` spawn at
    # api/src/routes/links.ts:61 (POST /api/links/detect).
    "links_generate": ("worker.handlers.links_generate", "run"),
    "auto_categorize": ("worker.handlers.auto_categorize", "run"),
    # Thin ctx-aware adapter at worker/handlers/analytics_inline dispatches
    # on payload['op'] to the two helpers in worker/analytics_inline
    # (sniff_article_cities, validate_url) — mirrors the feedback_suggest
    # pattern. Originally these were inline `python3 -c "<code>"` scripts
    # in api/src/routes/analytics.ts (sites ~497 and ~613).
    "analytics_inline": ("worker.handlers.analytics_inline", "run"),
    # Thin ctx-aware adapter at worker/handlers/community_triage wraps
    # the legacy worker.ai_validate.validate_request. Replaces the two
    # inline `python3 -m worker.ai_validate <id>` spawns in
    # api/src/routes/community.ts (~331, ~438). Both sites share the
    # same op ('ai_validate') because they call the same Python
    # helper; the sync/async distinction lives in the route layer's
    # waitMs choice.
    "community_triage": ("worker.handlers.community_triage", "run"),
    # Thin ctx-aware adapter at worker/handlers/feedback_suggest wraps
    # the legacy worker/fast_suggest.process_suggestion (mirrors the
    # explore_region pattern).
    "feedback_suggest": ("worker.handlers.feedback_suggest", "run"),
    # Audio pipeline handlers
    "audio_fetch": ("worker.audio_fetch", "run"),
    "audio_extract": ("worker.audio_extract", "run"),
    "audio_geocode": ("worker.audio_geocode", "run"),
    "audio_discover": ("worker.audio_discover", "run"),
    # Test-only synthetic kind (added in Task 0.10).
    "test_noop": ("worker.test_noop", "run"),
    # Test-only synthetic kind (added in Task 0.11) — long-running sleep that
    # polls ctx.check_cancel() so we can verify cancel reaches an in-flight job.
    "test_sleep": ("worker.test_sleep", "run"),
}

HEARTBEAT_INTERVAL_S = 2.0

# Max time to wait for an in-flight job to wind down cleanly on shutdown.
# Beyond this, the daemon threads are killed at process exit.
SHUTDOWN_GRACE_S = 2.0

# Upper bound on how long the heartbeat thread may take to notice its stop
# event and exit. Unrelated to HEARTBEAT_INTERVAL_S; this just keeps job
# teardown responsive if the heartbeat thread is wedged writing to stdout.
HEARTBEAT_JOIN_TIMEOUT_S = 3.0

# In-flight job contexts, keyed by job id. Populated when a job starts and
# popped when it finishes, so a `cancel` message can find the right ctx.
# v1 runs one job per worker at a time, but keying by id keeps `cancel`
# correct if that ever changes.
_current_ctx: dict[str, "JobContext"] = {}


class CancelledError(Exception):
    """Raised by handlers via ctx.check_cancel() to abort cleanly."""


class JobContext:
    """Passed to every handler as ``run(payload, ctx)``."""

    def __init__(self, job_id: str, send_fn: Callable[[dict[str, Any]], None]) -> None:
        self.job_id = job_id
        self.cancelled = False
        self._send = send_fn

    def check_cancel(self) -> None:
        """Raise CancelledError if a cancel message has arrived.

        Handlers should call this at natural checkpoints (between batches,
        between network calls) so cancellation is prompt but never leaves
        partial work in an inconsistent state.
        """
        if self.cancelled:
            raise CancelledError()

    def progress(
        self,
        *,
        step: str | None = None,
        pct: float | None = None,
        message: str | None = None,
        meta: dict[str, Any] | None = None,
        state: dict[str, Any] | None = None,
    ) -> None:
        """Emit a progress event.

        If ``state`` is provided, the Node side overwrites the job's `state`
        jsonb column with this dict (last-write-wins).
        """
        msg: dict[str, Any] = {"type": "progress", "id": self.job_id, "ts": time.time()}
        if step is not None:
            msg["step"] = step
        if pct is not None:
            msg["pct"] = pct
        if message is not None:
            msg["message"] = message
        if meta is not None:
            msg["meta"] = meta
        if state is not None:
            msg["state"] = state
        self._send(msg)

    def log(self, level: str, message: str, **fields: Any) -> None:
        """Emit a structured log event routed to the Node-side logger."""
        self._send(
            {
                "type": "log",
                "id": self.job_id,
                "level": level,
                "message": message,
                "fields": fields,
            }
        )


def send(msg: dict[str, Any]) -> None:
    """Write one JSON-lines message to stdout and flush immediately.

    Exits the process on a broken pipe: the parent (Node workerPool) has
    closed its end, so there is nobody left to talk to. Without this the
    exception would propagate up whichever thread happened to be writing
    (worker or heartbeat), killing it silently and leaving a zombie
    process behind that the pool would keep counting as alive.

    The `default=str` argument lets datetime / Decimal / UUID values in a
    handler's `result` round-trip without TypeError: the legacy CLI path
    on `worker/explore_region.py` already serializes its own stdout with
    this same default, so this keeps both paths consistent.
    """
    try:
        sys.stdout.write(json.dumps(msg, default=str) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        # os._exit (not sys.exit) on purpose: we want immediate termination
        # without running interpreter cleanup, which would try to flush the
        # very stdout that just failed and raise again from other threads.
        log_stderr("stdout closed by parent, exiting")
        os._exit(0)


def log_stderr(message: str) -> None:
    """Diagnostic output that must not touch the stdout IPC stream.

    Swallows OSError: when the parent dies it usually closes stderr too,
    and this is called from ``send``'s broken-pipe handler — a raise here
    would defeat the clean exit.
    """
    try:
        print(f"[dispatcher] {message}", file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def heartbeat_loop(job_id: str, stop_event: threading.Event) -> None:
    """Background thread emitting a heartbeat every HEARTBEAT_INTERVAL_S."""
    while not stop_event.is_set():
        stop_event.wait(HEARTBEAT_INTERVAL_S)
        if stop_event.is_set():
            break
        send({"type": "heartbeat", "id": job_id})


def _load_handler(
    kind: str,
    cache: dict[str, Callable[[Any, JobContext], Any]],
) -> Callable[[Any, JobContext], Any]:
    """Import a handler module on first use and return its entrypoint.

    Raises whatever import/attribute error occurs; the caller turns it into
    a `fail` event.
    """
    if kind not in cache:
        mod_path, fn_name = HANDLERS[kind]
        mod = importlib.import_module(mod_path)
        cache[kind] = getattr(mod, fn_name)
    return cache[kind]


def _start_job(
    msg: dict[str, Any],
    cache: dict[str, Callable[[Any, JobContext], Any]],
) -> tuple[threading.Thread, threading.Event, "JobContext | None"]:
    """Validate, set up ctx, and spawn a worker thread executing the handler.

    Returns ``(job_thread, job_done, ctx)``. ``job_done`` is set when the
    worker thread exits. ``ctx`` is None if the message was rejected before
    a context could be created (in which case ``job_done`` is set
    immediately and the terminal event has already been written).
    """
    job_id = msg.get("id")
    kind = msg.get("kind")

    if not isinstance(job_id, str) or not job_id:
        log_stderr(f"job message missing id, dropping: {msg!r}")
        return _noop_done()
    if not isinstance(kind, str) or kind not in HANDLERS:
        send(
            {
                "type": "fail",
                "id": job_id,
                "ts": time.time(),
                "error": f"unknown kind: {kind}",
                "traceback": None,
            }
        )
        return _noop_done()

    payload = msg.get("payload") or {}

    try:
        handler = _load_handler(kind, cache)
    except Exception as e:  # noqa: BLE001 - import errors must not kill the loop
        send(
            {
                "type": "fail",
                "id": job_id,
                "ts": time.time(),
                "error": f"failed to load handler {kind}: {e}",
                "traceback": traceback.format_exc(),
            }
        )
        return _noop_done()

    ctx = JobContext(job_id, send)
    # Publish the ctx BEFORE the worker thread does any work so a `cancel`
    # message that races in can find it. The main thread reads stdin
    # concurrently with the worker thread and may flip ctx.cancelled
    # mid-job — the handler is expected to call ctx.check_cancel() at
    # checkpoints.
    _current_ctx[job_id] = ctx

    stop_event = threading.Event()
    job_done = threading.Event()

    def run_job() -> None:
        # Heartbeat runs on its own thread so cancel latency is independent
        # of how long the handler sleeps between checkpoints.
        hb_thread = threading.Thread(
            target=heartbeat_loop, args=(job_id, stop_event), daemon=True
        )
        hb_thread.start()

        send({"type": "started", "id": job_id, "ts": time.time()})

        try:
            result = handler(payload, ctx)
            if ctx.cancelled:
                send({"type": "cancelled", "id": job_id})
            else:
                send({"type": "complete", "id": job_id, "ts": time.time(), "result": result})
        except CancelledError:
            send({"type": "cancelled", "id": job_id})
        except Exception as e:  # noqa: BLE001 - handler errors become fail events
            send(
                {
                    "type": "fail",
                    "id": job_id,
                    "ts": time.time(),
                    "error": str(e) or e.__class__.__name__,
                    "traceback": traceback.format_exc(),
                }
            )
        finally:
            stop_event.set()
            hb_thread.join(timeout=HEARTBEAT_JOIN_TIMEOUT_S)
            _current_ctx.pop(job_id, None)
            job_done.set()

    job_thread = threading.Thread(target=run_job, daemon=True)
    job_thread.start()
    return job_thread, job_done, ctx


def _noop_done() -> tuple[threading.Thread, threading.Event, None]:
    """Stand-in for jobs that fail validation before any work is started."""
    t = threading.Thread(target=lambda: None, daemon=True)
    t.start()
    done = threading.Event()
    done.set()
    return t, done, None


def main() -> None:
    slot_id: str | None = None
    for arg in sys.argv[1:]:
        if arg.startswith("--slot-id="):
            slot_id = arg.split("=", 1)[1]

    # kind -> handler callable, populated on first dispatch of that kind.
    cache: dict[str, Callable[[Any, JobContext], Any]] = {}

    send({"type": "ready", "worker_id": slot_id or "unknown"})

    # A reader thread drains stdin into a queue so the main thread can
    # process `cancel` messages while a job is running on a worker thread.
    # Without this split, the main thread would block inside the handler
    # call (synchronously) and any `cancel` would sit unread in the pipe
    # until the handler returned, by which point _current_ctx would be
    # empty and the cancel would be dropped as "unknown/finished job".
    msg_queue: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def _stdin_reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                log_stderr(f"IPC parse error: {e}: {line[:200]!r}")
                continue
            if not isinstance(msg, dict):
                log_stderr(f"IPC message is not an object, ignoring: {line[:200]!r}")
                continue
            msg_queue.put(msg)
        msg_queue.put(None)  # EOF sentinel

    threading.Thread(target=_stdin_reader, daemon=True).start()

    # The single-job-per-worker invariant: at most one in-flight job at a
    # time. ``in_flight`` is the worker thread's job_done event, or None.
    # ``pending`` holds a `job` message that arrived while another job was
    # still running; it gets started as soon as the current job finishes.
    in_flight: threading.Event | None = None
    pending: dict[str, Any] | None = None

    # How often main checks job_done while a job runs. Bounds cancel
    # latency from below: cancel can't be processed faster than this.
    POLL_INTERVAL_S = 0.05

    try:
        while True:
            # Detect the in-flight job finishing so we can clear state and
            # start any pending job before reading the next stdin message.
            if in_flight is not None and in_flight.is_set():
                in_flight = None
                if pending is not None:
                    next_msg = pending
                    pending = None
                    _thread, in_flight, _ctx = _start_job(next_msg, cache)
                    continue

            # Block waiting for the next message. When a job is running
            # we poll instead so cancel/shutdown are reachable mid-job.
            if in_flight is not None:
                try:
                    msg = msg_queue.get(timeout=POLL_INTERVAL_S)
                except queue.Empty:
                    continue
            else:
                if pending is not None:
                    msg = pending
                    pending = None
                else:
                    msg = msg_queue.get()

            if msg is None:  # stdin closed
                break

            t = msg.get("type")

            if t == "job":
                if in_flight is None or in_flight.is_set():
                    _thread, in_flight, _ctx = _start_job(msg, cache)
                else:
                    # v1: a worker runs one job at a time. Queue this one
                    # and start it when the current job finishes. Drop any
                    # earlier pending job — only the latest is meaningful.
                    if pending is not None:
                        log_stderr(
                            f"dropping pending job {pending.get('id', '?')!r} "
                            f"in favor of {msg.get('id', '?')!r}"
                        )
                    pending = msg

            elif t == "cancel":
                target_id = msg.get("id")
                ctx = _current_ctx.get(target_id) if isinstance(target_id, str) else None
                if ctx is not None:
                    ctx.cancelled = True
                else:
                    log_stderr(f"cancel for unknown/finished job: {target_id!r}")

            elif t == "heartbeat_check":
                # No-op at the dispatcher level; heartbeat_loop emits the
                # actual heartbeats. Kept as a message type for future use.
                pass

            elif t == "shutdown":
                break

            else:
                # Unknown message types are ignored rather than fatal so a
                # newer Node side can talk to an older worker.
                log_stderr(f"ignoring unknown message type: {t!r}")
    finally:
        # Best-effort: let any in-flight job wind down briefly before the
        # process exits. The handler is expected to be idempotent enough
        # to survive a forced exit at process shutdown.
        if in_flight is not None:
            in_flight.wait(timeout=SHUTDOWN_GRACE_S)


if __name__ == "__main__":
    main()
