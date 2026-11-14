"""Queue-callable handler for the ``community_triage`` job kind.

Replaces the two inline spawn sites in
``api/src/routes/community.ts`` (~lines 331 and 438), both of which
used the same Python CLI module to validate a community location-
correction request:

  ``python3 -m worker.ai_validate <request_id>``

Site A (~line 331) is fired in the background when a user casts a
"confirm" vote with a reason on an open ticket — pre-migration it was
``detached: true, stdio: "ignore", child.unref()`` (true fire-and-
forget). Site B (~line 438) is the admin manual trigger at
``POST /api/community/requests/:id/ai-validate`` — pre-migration it
``await``'d the Python process's JSON output and merged the result
into the request's ``result`` jsonb.

Both sites map to the same op (``"ai_validate"``) because they share
the underlying work; the sync/async distinction lives in the route
layer's ``waitMs`` choice. ``validate_request`` itself persists the
result into ``news_re_evaluate_requests.result->>'ai_validation'``
via ``_persist_result``, so callers can read the merged dict off
either ``/api/community/requests/:id`` or ``/api/discovery-status/:id``
``result`` field.

The area-request counterpart (``api/src/routes/community.ts``
~line 660) is fired on the first confirm vote of an area-coverage
request. It enqueues ``op: "ai_validate_area"`` which routes to
``worker.ai_validate_area.validate_area_request`` — that handler
writes a ``reply_type='ai'`` row into ``news_area_request_replies``
so the route's ``hasAi.length === 0`` idempotency check fires only
once per request.

The handler:

  * Polls ``ctx.check_cancel()`` once at the start so a `cancel` IPC
    message aborts the job before any work runs. ``validate_request``
    and ``validate_area_request`` are synchronous (DB lookup →
    optional AI chat → DB update) — no internal cancel checkpoints
    needed because the kind's 60s ceiling is much longer than a
    typical AI round-trip and a hard kill is preferable to
    half-validated state.
  * Passes through the optional ``force_heuristic`` flag (defaults to
    ``False``) so the route can request a non-AI run when the AI
    breaker is open.
  * Forwards ``request_id`` to ``worker.ai_validate.validate_request``
    or ``worker.ai_validate_area.validate_area_request`` and returns
    its unchanged result dict. ``ai_validate``'s result shape
    (``valid``, ``confidence``, ``reasoning``, ``suggested_place``,
    ``validated_at``, ``method``) matches what the legacy inline
    ``python3 -m worker.ai_validate`` script emitted, so the queue
    path is wire-compatible with the legacy fallback registered in
    ``api/src/legacy/communityTriage.ts``. ``ai_validate_area``'s
    result shape omits ``suggested_place`` (no equivalent concept).

Payload shape
-------------
op          : ``'ai_validate'`` | ``'ai_validate_area'``
request_id  : int | str        — the request row to validate
force_heuristic : bool (default False)
"""
from __future__ import annotations

from typing import Any

from worker.ai_validate import validate_request


_OPS = {
    "ai_validate": "ai_validate",
    "ai_validate_area": "ai_validate_area",
    "moderate_pin": "moderate_pin",
}


def run(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Dispatcher's entry point for the ``community_triage`` kind.

    Validates the payload, dispatches to the right validator
    (``worker.ai_validate``, ``worker.ai_validate_area`` or
    ``worker.pin_moderate``), and returns its unchanged result dict.
    Re-raises unknown ``op`` values so the dispatcher surfaces them as
    a ``fail`` event with a clear message instead of silently returning
    an empty dict.
    """
    ctx.check_cancel()

    op = payload.get("op")
    if op not in _OPS:
        raise ValueError(f"unknown community_triage op: {op!r}")

    # ── moderate_pin: stage-2 deep check of a community submission ──
    # (payload key is pin_id, not request_id — separate branch before
    # the shared request_id validation below).
    if op == "moderate_pin":
        raw_pin_id = payload.get("pin_id")
        try:
            pin_id = int(raw_pin_id)
        except (TypeError, ValueError):
            raise ValueError(
                f"moderate_pin payload requires numeric pin_id, got {raw_pin_id!r}"
            )
        from worker.pin_moderate import moderate_pin
        return moderate_pin(pin_id, user_category=payload.get("user_category"))

    raw_request_id = payload.get("request_id")
    if raw_request_id is None or raw_request_id == "":
        raise ValueError(
            f"community_triage payload requires non-empty request_id, "
            f"got {raw_request_id!r}"
        )
    try:
        request_id = int(raw_request_id)
    except (TypeError, ValueError):
        raise ValueError(
            f"community_triage payload requires numeric request_id, "
            f"got {raw_request_id!r}"
        )

    force_heuristic = bool(payload.get("force_heuristic", False))

    if op == "ai_validate":
        return validate_request(request_id, force_heuristic=force_heuristic)
    # op == "ai_validate_area"
    from worker.ai_validate_area import validate_area_request
    return validate_area_request(request_id, force_heuristic=force_heuristic)
