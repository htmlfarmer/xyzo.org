"""Queue-callable handler for the ``sources_audit`` job kind.

Dispatches on ``payload['op']`` to one of three helpers — replacing the
three inline spawn sites in ``api/src/routes/sources.ts``:

  * ``op == 'discover'`` (~line 243, POST /api/sources/discover) — runs
    ``worker.source_discovery.discover_sources``. This is a synchronous
    route that returns the discovery result directly, so the route layer
    uses sync-wait (``waitMs > 0``) and forwards ``result.result``.

  * ``op == 'auto_correct'`` (~line 491, POST /api/density/auto-correct)
    — runs ``worker.density.auto_correct_density``. Fire-and-forget at
    the route layer; the route returns the jobId and the polling
    endpoint reads from ``discovery_jobs.state``.

  * ``op == 'relocate'`` (~line 558, POST /api/density/relocate) — runs
    ``worker.relocate.relocate_batch``. Same fire-and-forget pattern as
    ``auto_correct``.

Payload shape
-------------
``op`` : ``'discover'`` | ``'auto_correct'`` | ``'relocate'``

``discover`` extras::

    query       : str
    country     : str | None   (ISO 2-letter code)
    strategies  : list[str] | None

``auto_correct`` extras::

    bbox   : list[float] | None   # [minLng, minLat, maxLng, maxLat]
    job_id : str | None           # mirrored in legacy spawn key for
                                   # backwards compat with the in-memory
                                   # densityJobs map

``relocate`` extras::

    limit        : int  (default 200)
    only_flagged : bool (default True)

Cancellation
------------
Each op calls ``ctx.check_cancel()`` once at entry so a `cancel` IPC
message aborts the job before any work runs. Detailed per-cluster
progress callbacks are intentionally NOT threaded through the worker
modules in v1 — the polling endpoint sees ``state = {step: 'starting',
detail: '...'}`` until the job finishes, mirroring the auto_categorize
and feedback_suggest handlers. The auto-categorize frontend already
tolerates this pattern; the density frontend will show "running..." with
elapsed_ms until the job terminates.
"""
from __future__ import annotations

from typing import Any

from worker.density import auto_correct_density
from worker.relocate import relocate_batch
from worker.source_discovery import discover_sources


def _op_discover(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Run the source discovery flow and return its result unchanged.

    The wrapper for ``worker.source_discovery.discover_sources`` keeps
    the legacy wire shape (``query``, ``country``, ``strategies_used``,
    ``candidates``, ``already_exists``, ``summary``) — see the legacy
    ``api/src/legacy/sourcesAudit.ts`` spawner, which produces the same
    object from the CLI entry point.
    """
    query = payload.get("query")
    if not isinstance(query, str) or not query:
        raise ValueError(
            f"sources_audit discover payload requires non-empty query, got {query!r}"
        )
    country = payload.get("country")
    strategies = payload.get("strategies")
    return discover_sources(query=query, country=country, strategies=strategies)


def _op_auto_correct(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Run density auto-correction; emit a single start frame via ctx.

    Forwards the optional ``bbox`` and the optional ``job_id`` (kept for
    legacy-spawn parity) to ``worker.density.auto_correct_density``.
    """
    ctx.check_cancel()

    bbox = payload.get("bbox")
    if bbox is not None:
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            raise ValueError(
                f"sources_audit auto_correct payload requires bbox="
                f"[minLng,minLat,maxLng,maxLat] or None, got {bbox!r}"
            )
        bbox = [float(v) for v in bbox]

    job_id = payload.get("job_id")

    # Initial progress frame so the polling endpoint sees the job is alive.
    # v1 does not thread the per-cluster progress callbacks from
    # worker.density through ctx.progress; the polling endpoint will show
    # this frame until the job terminates. The frontend tolerates this.
    ctx.progress(
        state={
            "step": "starting",
            "detail": "Running density analysis on pins in viewport...",
        }
    )

    return auto_correct_density(job_id=job_id, bbox=bbox)


def _op_relocate(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Run batch relocation; emit a single start frame via ctx."""
    ctx.check_cancel()

    raw_limit = payload.get("limit", 200)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        raise ValueError(
            f"sources_audit relocate payload requires numeric limit, got {raw_limit!r}"
        )
    only_flagged = bool(payload.get("only_flagged", True))

    ctx.progress(
        state={
            "step": "starting",
            "detail": "Relocating mislocated articles...",
        }
    )

    return relocate_batch(limit=limit, only_flagged=only_flagged)


_OPS = {
    "discover": _op_discover,
    "auto_correct": _op_auto_correct,
    "relocate": _op_relocate,
}


def run(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Dispatcher's entry point for the ``sources_audit`` kind.

    Routes the payload to the matching op handler and returns its
    unchanged result dict. Re-raises unknown ``op`` values so the
    dispatcher surfaces them as a ``fail`` event with a clear message
    instead of silently returning an empty dict.
    """
    op = payload.get("op")
    fn = _OPS.get(op) if isinstance(op, str) else None
    if fn is None:
        raise ValueError(f"unknown sources_audit op: {op!r}")
    return fn(payload, ctx)
