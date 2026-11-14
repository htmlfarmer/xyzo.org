"""Dev-only synthetic handler used by worker/tests/test_noop.py.

Sleeps for ``payload['sleep_ms']`` milliseconds (default 100), emitting a
``progress`` event every ``payload['progress_every_ms']`` milliseconds
(default 50; set to 0 to suppress). Each tick is a checkpoint: the
handler calls ``ctx.check_cancel()`` so a `cancel` IPC message aborts
the job promptly.

Payload
-------
sleep_ms          : int, total work duration in ms (default 100)
progress_every_ms : int, ms between progress events (default 50, 0 = silent)
final_result      : dict, value returned on success (default {"ok": True})
fail              : bool, if true raise RuntimeError instead of returning
error             : str, message for the synthetic failure (default 'test failure')

Cancellation is NOT swallowed: ``ctx.check_cancel()`` raises
``CancelledError`` and the caller (``worker.dispatcher._run_job_thread``
in dispatcher.py) turns it into a `cancelled` IPC event.

NOT for production: registered as `test_noop` in worker.dispatcher.HANDLERS.
"""
from __future__ import annotations

import time

from worker.dispatcher import CancelledError


DEFAULT_SLEEP_MS = 100
DEFAULT_PROGRESS_EVERY_MS = 50


def run(payload: dict, ctx) -> dict:
    sleep_ms = int(payload.get("sleep_ms", DEFAULT_SLEEP_MS))
    progress_every_ms = int(payload.get("progress_every_ms", DEFAULT_PROGRESS_EVERY_MS))
    final_result = payload.get("final_result", {"ok": True})
    fail = bool(payload.get("fail", False))

    if fail:
        # Synthetic failure: tests inspect the resulting `error` field
        # and the auto-generated traceback. Default message keeps the
        # handler usable even when the payload omits `error`.
        raise RuntimeError(str(payload.get("error", "test failure")))

    total_ms = max(sleep_ms, 0)
    chunk_ms = progress_every_ms if progress_every_ms > 0 else total_ms
    started = time.time()
    deadline = started + (total_ms / 1000.0)

    while True:
        remaining_ms = (deadline - time.time()) * 1000.0
        if remaining_ms <= 0:
            break

        # Sleep in chunks so progress + cancel checkpoints fire at the
        # requested cadence. Cap the chunk at `remaining_ms` so we never
        # overshoot the deadline.
        sleep_for_s = min(chunk_ms, max(remaining_ms, 0)) / 1000.0
        time.sleep(sleep_for_s)

        # Check cancellation BEFORE emitting progress: a cancelled job
        # should never advertise forward motion.
        ctx.check_cancel()

        elapsed_ms = (time.time() - started) * 1000.0
        pct = (elapsed_ms / total_ms) if total_ms > 0 else 1.0
        # state matches what statusWriter expects: a flat dict the
        # server stores verbatim in jobs.state (last-write-wins replace,
        # not merge). Keep both `step` and `progress` so callers can
        # render either field.
        ctx.progress(
            step="working",
            pct=pct,
            state={"step": "working", "progress": pct},
        )

    return final_result
