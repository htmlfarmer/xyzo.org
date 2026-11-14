"""Queue-callable handler for the ``auto_categorize`` job kind.

Wraps ``worker.auto_categorize.run`` so it runs under the dispatcher's
``run(payload, ctx)`` contract. The handler:

  * Forwards the optional ``limit`` from the payload to ``run``. A
    ``limit`` of 0 (or its absence) means "drain the backlog up to the
    worker's hard cap of 10,000".
  * Polls ``ctx.check_cancel()`` once at the start so a `cancel` IPC
    message aborts the job before any work runs. The function itself
    runs synchronously (no internal cancel checkpoints) because the
    5-second sync-wait budget makes a fast kill preferable to a
    half-completed batch.
  * Leaves ``worker/auto_categorize.py`` untouched, so its existing
    ``__main__`` CLI (``python3 -m worker.auto_categorize``) keeps
    working for ad-hoc local runs.

Payload shape
-------------
limit : int (default 0)
"""
from __future__ import annotations

from typing import Any

from worker.auto_categorize import run as auto_categorize_run


def run(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Dispatcher's entry point for the ``auto_categorize`` kind.

    Forwards the optional ``limit`` (capped at 10_000 to match the
    worker's hard cap) to ``run`` and returns its unchanged summary
    dict. The shape (counters for ``fast_path_high`` / ``fast_path_medium``
    / ``fast_path_low`` / ``source_fallback`` / ``no_match`` / ``needs_ai``
    / ``flood_blocked``) is what the admin endpoint already renders, so
    the queue path is wire-compatible with the legacy spawn path.
    """
    # Single cancel checkpoint before any work runs — keeps the contract
    # with the dispatcher (handlers must poll ctx.check_cancel()) without
    # threading checkpoints through run(), which is a synchronous batch
    # flow that exceeds the 5s sync-wait budget on large backlogs.
    ctx.check_cancel()

    raw_limit = payload.get("limit", 0)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        raise ValueError(
            f"auto_categorize payload requires numeric limit, got {raw_limit!r}"
        )
    if limit < 0:
        raise ValueError(
            f"auto_categorize payload requires non-negative limit, got {limit}"
        )
    # Match the worker's contract: 0 → drain (hard cap of 10_000),
    # otherwise clamp to 10_000 so a runaway request can't lock up the DB.
    limit = 0 if limit == 0 else min(limit, 10_000)

    return auto_categorize_run(limit=limit, progress=None)