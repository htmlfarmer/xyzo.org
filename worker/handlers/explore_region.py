"""Queue-callable handler for the ``explore_region`` job kind.

Wraps ``worker.explore_region.explore_region`` so it runs under the
dispatcher's ``run(payload, ctx)`` contract. The handler:

  * Builds an adapter that implements the ``ProgressWriter`` interface
    the legacy orchestrator already calls (``update(...)``,
    ``finish(...)``), then forwards every change to ``ctx.progress(
    state=...)`` so the status writer persists the latest state to
    ``discovery_jobs.state`` (jsonb).
  * Polls ``ctx.check_cancel()`` at every step boundary so a `cancel`
    IPC message aborts the job promptly.
  * Leaves the legacy ``worker/explore_region.py`` orchestrator and its
    CLI entry point untouched, so existing callers (the synchronous
    HTTP route, batch scripts) keep working.

Payload shape
-------------
bbox           : list[float]   # [minLng, minLat, maxLng, maxLat]
auto_add       : bool          # default False
category_hint  : str | None    # optional topic focus
"""
from __future__ import annotations

import logging
import time
from typing import Any

from worker.explore_region import explore_region

log = logging.getLogger("xyzo.explore_region_handler")


# Coarse-grained weights: roughly how much of the wall-clock budget each
# top-level step tends to consume. Used only to compute ``progress`` for
# the status payload — the orchestrator's real per-source counters land
# in ``state['counters']`` and override this when present.
_STEP_WEIGHTS = {
    "cities": 0.10,
    "countries": 0.10,
    "search": 0.05,
    "web_search": 0.30,
    "discover": 0.10,
    "validate": 0.25,
    "add": 0.10,
}


def _step_progress(name: str | None) -> float:
    """Return the coarse progress fraction for a step name."""
    if not name:
        return 0.0
    cumulative = 0.0
    for step_name, weight in _STEP_WEIGHTS.items():
        cumulative += weight
        if step_name == name:
            return min(cumulative, 0.99)
    return 0.0


class _CtxProgressAdapter:
    """Implements the legacy ``ProgressWriter`` surface for ``ctx``.

    The orchestrator (``worker.explore_region.explore_region``) and its
    helpers call ``progress.update(step=..., detail=..., counters=...,
    recent_source=...)`` and ``progress.finish(step=..., detail=...)``.
    This adapter accepts those calls and re-emits them as ``ctx.progress(
    state=...)`` so the queue's status writer (Task 1.3) can persist
    them to ``discovery_jobs.state``.

    The state schema mirrors the plan: ``current_step``, ``step_detail``,
    ``progress``, ``center``, ``elapsed_seconds``, ``counters``,
    ``recent_articles``, ``recent_sources``. It also carries the legacy
    ``step`` / ``detail`` keys so the existing ``/api/discovery-status/
    :id`` route keeps working during the cutover window.
    """

    def __init__(self, ctx, bbox: list[float]) -> None:
        self._ctx = ctx
        self._bbox = bbox
        now = time.time()
        min_lng, min_lat, max_lng, max_lat = bbox
        self._state: dict[str, Any] = {
            "current_step": "starting",
            "step_detail": "Initializing discovery",
            "progress": 0.0,
            "center": {
                "lat": (min_lat + max_lat) / 2.0,
                "lng": (min_lng + max_lng) / 2.0,
            },
            "elapsed_seconds": 0.0,
            "started_at": now,
            # Legacy keys kept for /api/discovery-status during cutover:
            "step": "init",
            "detail": "Starting discovery...",
            "counters": {
                "articles_fetched": 0,
                "articles_extracted": 0,
                "articles_geocoded": 0,
                "sources_added": 0,
                "sources_geocoded": 0,
            },
            "recent_articles": [],
            "recent_sources": [],
        }

    # ── ProgressWriter surface ──────────────────────────────────────────

    def update(
        self,
        *,
        step: str | None = None,
        detail: str | None = None,
        counters: dict | None = None,
        recent_article: dict | None = None,
        recent_source: dict | None = None,
        finished: bool = False,
    ) -> None:
        """Mirror ``ProgressWriter.update``; forward as ctx.progress."""
        if step is not None:
            self._state["current_step"] = step
            self._state["step"] = step
            self._state["progress"] = _step_progress(step)
        if detail is not None:
            self._state["step_detail"] = detail
            self._state["detail"] = detail
        if counters:
            for k, v in counters.items():
                if k in self._state["counters"]:
                    try:
                        self._state["counters"][k] = int(v)
                    except (TypeError, ValueError):
                        pass
        if recent_article is not None:
            items = self._state["recent_articles"]
            items.insert(0, recent_article)
            if len(items) > 25:
                del items[25:]
        if recent_source is not None:
            items = self._state["recent_sources"]
            items.insert(0, recent_source)
            if len(items) > 25:
                del items[25:]

        self._state["elapsed_seconds"] = time.time() - self._state["started_at"]
        if finished:
            self._state["progress"] = 1.0
            self._state["finished_at"] = time.time()

        # Cancel checkpoint + status flush happen at every step boundary,
        # so a `cancel` IPC reaches us between consecutive step() calls.
        self._ctx.check_cancel()
        self._ctx.progress(state=dict(self._state))

    def finish(self, step: str = "complete", detail: str = "Discovery finished") -> None:
        """Mirror ``ProgressWriter.finish``."""
        self.update(step=step, detail=detail, finished=True)


def run(payload: dict, ctx) -> dict:
    """Dispatcher's entry point for the ``explore_region`` kind.

    Accepts the standard payload (``bbox``, ``auto_add``, optional
    ``category_hint``), forwards to the legacy orchestrator with a
    ctx-aware ProgressWriter adapter, and returns the orchestrator's
    unchanged result dict.
    """
    bbox = payload.get("bbox")
    if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
        raise ValueError(
            f"explore_region payload requires bbox=[minLng,minLat,maxLng,maxLat], got {bbox!r}"
        )
    bbox = [float(v) for v in bbox]

    auto_add = bool(payload.get("auto_add", False))
    category_hint = payload.get("category_hint")
    request_id = payload.get("request_id")  # news_area_requests.id for status updates

    adapter = _CtxProgressAdapter(ctx, bbox)
    # Flush an "initializing" frame before any work begins so consumers
    # polling /api/discovery-status immediately see the job is alive.
    adapter.update(step="cities", detail=f"Queued for bbox {bbox}")

    result = explore_region(
        bbox,
        auto_add=auto_add,
        progress=adapter,
        request_id=None,  # queue path doesn't use the legacy resume file
        category_hint=category_hint,
        ctx=ctx,
    )

    # Final progress tick in case the orchestrator's last update was
    # swallowed (e.g. auto_add=False skips the "add" step but never
    # explicitly sets progress=1.0).
    ctx.check_cancel()
    ctx.progress(state={**adapter._state, "progress": 1.0, "finished": True})

    # Update news_area_requests status if we have a request_id
    if request_id:
        try:
            from worker.db import connect
            with connect() as conn, conn.cursor() as cur:
                cur.execute(
                    "UPDATE news_area_requests SET status = 'completed', processed_at = now() WHERE id = %s",
                    (request_id,)
                )
                conn.commit()
        except Exception as e:
            log.warning("Failed to update news_area_requests %s: %s", request_id, e)

    return result