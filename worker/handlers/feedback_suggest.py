"""Queue-callable handler for the ``feedback_suggest`` job kind.

Wraps ``worker.fast_suggest.process_suggestion`` so it runs under the
dispatcher's ``run(payload, ctx)`` contract. The handler:

  * Adapts the dict payload shape the API sends to the legacy
    ``process_suggestion`` signature (pin_id / article_id / user_place /
    lat / lng / radius_km).
  * Polls ``ctx.check_cancel()`` once at the start so a `cancel` IPC
    message aborts the job before any work runs. The function itself
    runs synchronously (no internal cancel checkpoints) because the
    5-second sync-wait budget makes a fast kill preferable to
    half-completed state.
  * Leaves the legacy ``worker/fast_suggest.py`` logic untouched, so the
    existing ``worker.fast_suggest_cli`` CLI entry point keeps working
    for ad-hoc local runs.

Payload shape
-------------
pin_id          : int
article_id      : int
user_place      : str | None
lat             : float | None
lng             : float | None
radius_km       : float (default 25)
map_center_lat  : float | None (optional, captured at submit time)
map_center_lng  : float | None (optional, captured at submit time)
map_zoom        : int | None (optional, captured at submit time)
"""
from __future__ import annotations

from typing import Any

from worker.fast_suggest import process_suggestion


def run(payload: dict, ctx) -> dict:
    """Dispatcher's entry point for the ``feedback_suggest`` kind.

    Forwards the payload to ``process_suggestion`` and returns its
    unchanged result dict. The shape (``applied``, ``steps``,
    ``result``, ``reasoning``, ``total_ms``) is what the frontend's
    fast-suggest dialog already renders, so the queue path is wire-
    compatible with the legacy spawn path.
    """
    # Single cancel checkpoint before any work runs — keeps the contract
    # with the dispatcher (handlers must poll ctx.check_cancel()) without
    # threading checkpoints through process_suggestion, which is a
    # synchronous best-effort flow that completes in < 5s normally.
    ctx.check_cancel()

    pin_id = payload.get("pin_id")
    article_id = payload.get("article_id")
    if pin_id is None or article_id is None:
        raise ValueError(
            f"feedback_suggest payload requires pin_id and article_id, got {payload!r}"
        )

    result = process_suggestion(
        pin_id=int(pin_id),
        article_id=int(article_id),
        user_place=payload.get("user_place"),
        lat=payload.get("lat"),
        lng=payload.get("lng"),
        radius_km=float(payload.get("radius_km") or 25),
        map_center_lat=payload.get("map_center_lat"),
        map_center_lng=payload.get("map_center_lng"),
        map_zoom=payload.get("map_zoom"),
    )
    return result