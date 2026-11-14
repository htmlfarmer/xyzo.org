"""Dev-only test handler used by worker/tests/test_dispatcher.py.

Sleeps for ``payload['sleep']`` seconds (default 2), polling
``ctx.check_cancel()`` every ~100ms so a `cancel` message aborts the job
promptly. Used to verify the dispatcher's worker-thread architecture
actually lets cancel reach an in-flight job.

NOT for production: registered as `test_sleep` in worker.dispatcher.HANDLERS.
"""
from __future__ import annotations

import time

from worker.dispatcher import CancelledError


POLL_INTERVAL_S = 0.1


def run(payload: dict, ctx) -> dict:
    total = float(payload.get("sleep", 2))
    started = time.time()
    deadline = started + total

    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        # check_cancel() raises CancelledError if the main thread set
        # ctx.cancelled in response to a `cancel` IPC message.
        ctx.check_cancel()
        time.sleep(min(POLL_INTERVAL_S, remaining))

    return {"slept": time.time() - started}
