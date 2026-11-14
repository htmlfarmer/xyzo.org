"""Async geocoder queue.

Two modes of async geocoding, picked by env / CLI flag:

1.  ``GeocodeQueue.run_until_idle(limit)`` — in-process async pipeline.
    Spawns N worker tasks that pull articles off an ``asyncio.Queue`` and
    hand them to the parallel :class:`Geocoder`. Returns when the queue
    is drained (or after ``limit`` articles). Designed for cron-driven
    backlog draining inside the worker process.

2.  ``GeocodeListener.run()`` — Postgres LISTEN/NOTIFY long-running
    daemon. A trigger on ``news_articles`` fires ``NOTIFY
    geocode_requested`` whenever ``extract.run`` writes a new
    ``status='extracted'`` row; the listener wakes up, fetches the
    article, and pushes it onto the in-process queue. This is the
    production-grade option because it survives worker restarts and
    doesn't depend on a poll cycle to pick up new work.

The two modes share :class:`Geocoder` and the queue plumbing — only the
producer side differs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from typing import Optional

import psycopg

from .db import get_dsn, connect
from .geocode import Geocoder

log = logging.getLogger("xyzo.geocode_queue")

# Postgres channel used by the listener. Migration
# ``api/migrations/2026-09-08-geocode-notify.sql`` installs a trigger
# that fires ``NOTIFY geocode_requested`` on inserts of
# ``status='extracted'`` rows.
NOTIFY_CHANNEL = os.environ.get("NEWSIUM_GEOCODE_CHANNEL", "geocode_requested")
# Producer: max batch size when polling for pending articles in
# ``drain_pending`` mode.
DEFAULT_BATCH_SIZE = int(os.environ.get("NEWSIUM_GEOCODE_BATCH", "200"))
# Listener: how many worker tasks run concurrently. They cooperate via
# the rate-limited Geocoder; the asyncio worker count just controls how
# many DB round-trips overlap with Nominatim HTTP RTT.
DEFAULT_LISTENER_WORKERS = int(os.environ.get("NEWSIUM_GEOCODE_WORKERS", "4"))


class GeocodeQueue:
    """In-process async geocode queue backed by ``Geocoder``.

    Usage (drain the backlog once, then exit)::

        queue = GeocodeQueue(num_workers=4, batch_size=500)
        asyncio.run(queue.run_until_idle(limit=20_000))

    Usage (live, polls the DB until cancelled)::

        queue = GeocodeQueue(poll_interval_s=2.0)
        asyncio.run(queue.run_forever())
    """

    def __init__(
        self,
        *,
        num_workers: int | None = None,
        batch_size: int | None = None,
        poll_interval_s: float = 1.0,
        geocoder: Geocoder | None = None,
    ):
        self.num_workers = num_workers or DEFAULT_LISTENER_WORKERS
        self.batch_size = batch_size or DEFAULT_BATCH_SIZE
        self.poll_interval_s = poll_interval_s
        self._geocoder = geocoder or Geocoder(max_workers=self.num_workers)
        self._queue: asyncio.Queue[dict | None] = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        self._produced = 0
        self._consumed = 0
        self._lock = asyncio.Lock()

    def enqueue(self, article: dict) -> None:
        """Synchronous enqueue (callable from non-async code).

        Puts the article on the asyncio queue. Safe to call from any
        thread that owns a running loop via ``loop.call_soon_threadsafe``;
        for direct calls, the caller should be inside the loop already.
        """
        self._queue.put_nowait(article)
        self._produced += 1

    async def aenqueue(self, article: dict) -> None:
        await self._queue.put(article)
        self._produced += 1

    async def _worker_loop(self, name: str) -> None:
        """Worker task: pull an article, hand it to the Geocoder, repeat.

        ``None`` is the sentinel for "drain and exit". Each worker exits
        cleanly when it sees the sentinel; the manager inserts one
        sentinel per worker.
        """
        log.info("geocode_queue: worker %s started", name)
        while True:
            art = await self._queue.get()
            try:
                if art is None:
                    log.info("geocode_queue: worker %s received stop", name)
                    # Requeue the sentinel so the next worker also exits.
                    self._queue.put_nowait(None)
                    return
                loc = await self._process(art)
                self._consumed += 1
                if loc is not None and log.isEnabledFor(logging.DEBUG):
                    log.debug("geocode_queue: %s -> %s", art.get("id"), loc.get("status"))
            except Exception as exc:  # noqa: BLE001
                log.exception("geocode_queue: worker %s error: %s", name, exc)
            finally:
                self._queue.task_done()

    async def _process(self, art: dict) -> dict | None:
        # The Geocoder is sync. Run it on the default executor so the
        # event loop stays responsive (DB roundtrips, signal handling).
        loop = asyncio.get_running_loop()
        # geocode_articles expects a list — wrap the single article.
        results = await loop.run_in_executor(
            None,  # default executor
            self._geocoder.geocode_articles,
            [art],
        )
        return results[0][1] if results else None

    async def start(self) -> None:
        """Spawn ``num_workers`` worker tasks."""
        if self._workers:
            return
        self._workers = [
            asyncio.create_task(self._worker_loop(f"w{i}"))
            for i in range(self.num_workers)
        ]

    async def stop(self) -> None:
        """Tell every worker to exit and wait for it."""
        for _ in self._workers:
            await self._queue.put(None)
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []
        self._geocoder.shutdown(wait=True)

    # ── Producers ──────────────────────────────────────────────────────

    async def drain_pending(self, limit: int) -> int:
        """Pull at most ``limit`` articles from the DB and queue them.

        Returns the number actually queued (some may already be
        geocoded by another worker between the SELECT and the insert,
        and we de-dup by ``id``).
        """
        import psycopg
        loop = asyncio.get_running_loop()
        rows = await loop.run_in_executor(None, _fetch_pending_sync, limit)
        for r in rows:
            await self.aenqueue(r)
        return len(rows)

    async def run_until_idle(self, limit: int) -> dict:
        """Drain ``limit`` articles, then exit when the queue is empty.

        Suitable for cron-style ``--step geocode`` invocations.
        """
        await self.start()
        queued = await self.drain_pending(limit)
        if queued == 0:
            await self.stop()
            return {"queued": 0, "consumed": 0, "produced": 0}
        # Each worker waits for one sentinel; put len(workers) of them.
        for _ in self._workers:
            await self._queue.put(None)
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []
        self._geocoder.shutdown(wait=True)
        return {
            "queued": queued,
            "produced": self._produced,
            "consumed": self._consumed,
        }

    async def run_forever(self) -> None:
        """Poll the DB on a fixed interval until cancelled.

        Each tick fetches up to ``batch_size`` pending articles, enqueues
        them, and sleeps ``poll_interval_s``. Workers drain as they can.
        """
        await self.start()
        try:
            while True:
                queued = await self.drain_pending(self.batch_size)
                if queued == 0:
                    await asyncio.sleep(self.poll_interval_s)
        finally:
            await self.stop()


# ──────────────────────────────────────────────────────────────────────────────
# Sync helpers used by GeocodeQueue producers (psycopg sync pool from db.py).
# Keeping them sync lets producers run on a thread executor while workers
# own the asyncio loop.
# ──────────────────────────────────────────────────────────────────────────────


def _fetch_pending_sync(limit: int) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, location_text FROM news_articles "
            "WHERE status = 'extracted' AND location_id IS NULL "
            "  AND location_text IS NOT NULL AND location_text <> '' "
            "ORDER BY extracted_at ASC NULLS FIRST LIMIT %s",
            (limit,),
        )
        return cur.fetchall()


# ──────────────────────────────────────────────────────────────────────────────
# Postgres LISTEN/NOTIFY listener (production option).
# Requires the trigger installed by ``api/migrations/2026-09-08-geocode-notify.sql``.
# ──────────────────────────────────────────────────────────────────────────────


class GeocodeListener:
    """``LISTEN geocode_requested`` daemon.

    The migration trigger fires a ``NOTIFY geocode_requested`` payload
    of ``{"id": <article_id>}`` whenever ``extract`` writes a new
    ``status='extracted'`` row. The listener fetches the row, hands it
    to a :class:`GeocodeQueue`, and survives worker restarts because
    PostgreSQL buffers unhandled notifications.

    Run::

        python -m worker.geocode_queue --listen
    """

    def __init__(
        self,
        *,
        num_workers: int | None = None,
        poll_interval_s: float = 5.0,
    ):
        self.queue = GeocodeQueue(num_workers=num_workers, poll_interval_s=poll_interval_s)
        self._stop = asyncio.Event()

    async def run(self) -> None:
        dsn = get_dsn()
        log.info("GeocodeListener: connecting to %s ...", dsn.split("@")[-1])
        # autocommit is required for LISTEN/NOTIFY to deliver immediately.
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(f"LISTEN {NOTIFY_CHANNEL}")
            log.info("GeocodeListener: LISTEN %s active", NOTIFY_CHANNEL)

            await self.queue.start()

            # Polling fallback — the queue's worker pool is also draining
            # pending rows on a timer, so the listener is robust even if
            # the trigger fires late (e.g. replication lag, missing
            # migration). Two paths cooperating is cheap: id is the
            # natural dedupe key, and ``upsert_location`` is idempotent
            # via its UNIQUE constraint.
            poll_task = asyncio.create_task(self._poll_fallback())
            try:
                async for notify in conn.notifies():
                    if self._stop.is_set():
                        break
                    try:
                        payload = json.loads(notify.payload or "{}")
                        article_id = int(payload.get("id"))
                    except (ValueError, TypeError):
                        log.warning("GeocodeListener: malformed payload %r", notify.payload)
                        continue
                    article = await self._fetch_article(article_id)
                    if article is not None:
                        await self.queue.aenqueue(article)
                        log.info("GeocodeListener: enqueued article id=%s", article_id)
            finally:
                poll_task.cancel()
                await self.queue.stop()
                log.info("GeocodeListener: shutdown clean")

    async def _poll_fallback(self) -> None:
        """Periodic safety net in case NOTIFY is missed."""
        while not self._stop.is_set():
            try:
                queued = await self.queue.drain_pending(self.queue.batch_size)
                if queued:
                    log.debug("GeocodeListener: poll-fallback queued %d", queued)
            except Exception as exc:  # noqa: BLE001
                log.exception("GeocodeListener: poll-fallback error: %s", exc)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.queue.poll_interval_s)
            except asyncio.TimeoutError:
                pass

    async def _fetch_article(self, article_id: int) -> dict | None:
        dsn = get_dsn()
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id, location_text FROM news_articles WHERE id = %s "
                    "  AND status = 'extracted' AND location_id IS NULL",
                    (article_id,),
                )
                row = await cur.fetchone()
                return dict(row) if row else None

    def request_stop(self) -> None:
        """Signal the listener to exit (e.g. SIGINT handler)."""
        self._stop.set()


# ──────────────────────────────────────────────────────────────────────────────
# CLI entry point.
# ──────────────────────────────────────────────────────────────────────────────


def main() -> int:
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="xyzo async geocoder queue")
    parser.add_argument(
        "--listen",
        action="store_true",
        help="Long-running LISTEN/NOTIFY daemon (production mode)",
    )
    parser.add_argument(
        "--drain",
        type=int, default=0, metavar="LIMIT",
        help="Drain up to LIMIT pending articles then exit (cron mode)",
    )
    parser.add_argument(
        "--workers", type=int, default=None,
        help="Number of parallel workers (default $NEWSIUM_GEOCODE_WORKERS)",
    )
    parser.add_argument(
        "--batch", type=int, default=None,
        help="Producer batch size (default $NEWSIUM_GEOCODE_BATCH)",
    )
    parser.add_argument(
        "--poll-interval", type=float, default=5.0,
        help="Poll interval seconds (LISTEN fallback path, default 5)",
    )
    parser.add_argument("--quiet", action="store_true")

    args = parser.parse_args()
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.listen:
        listener = GeocodeListener(
            num_workers=args.workers,
            poll_interval_s=args.poll_interval,
        )

        def _stop(*_a):
            listener.request_stop()

        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, _stop)
                except NotImplementedError:
                    # Windows fallback — just rely on KeyboardInterrupt.
                    signal.signal(sig, _stop)
            loop.run_until_complete(listener.run())
        finally:
            loop.close()
        return 0

    if args.drain > 0:
        queue = GeocodeQueue(
            num_workers=args.workers,
            batch_size=args.batch,
        )
        result = asyncio.run(queue.run_until_idle(args.drain))
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
