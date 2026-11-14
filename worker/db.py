"""Postgres connection helper for the xyzo worker.

Reads DSN from (in priority order):
  1. XYZO_DB_DSN       — canonical after the Newsium → XYZO rebrand
  2. XYZO_DB_URL       — used by api/.env; accepted so the worker can be
                         launched under the same env file as the API
  3. DATABASE_URL      — generic Postgres convention
  4. NEWSIUM_DB_DSN    — pre-rebrand legacy name

Required — there is no default, so a misconfigured deploy fails fast instead
of silently using a dev database. The historical bug behind T-22 was that
api/.env exports XYZO_DB_URL but the worker only looked for XYZO_DB_DSN,
so `python -m worker.source_cadence --update` crashed silently on every
systemd timer run and the per-source counters drifted to all-zero.

Connection pooling (Tier 1.3 — Audit 4 fix, "connection storm under load")
--------------------------------------------------------------------------
A single module-level :class:`psycopg_pool.ConnectionPool` is shared across
all worker threads. Every call to :func:`connect` checks out a connection
from the pool, yields it to the caller, and returns it on context exit.

The previous implementation opened a fresh ``psycopg.connect()`` per call.
Under parallel fetch + geocode + backfill + cron, that fanned out to
hundreds of TCP+auth roundtrips, which:

* hit the ~5–50 ms connect overhead per short query (10–30 % throughput
  tax), and
* could exhaust Postgres' ``max_connections`` limit (default 100) and
  start refusing new connections with
  ``FATAL: too many connections for role "xyzo"``.

The pool is configured via env vars (with safe defaults for a single
worker process on a small box):

==========================  =========================================
Env var                     Default  Meaning
==========================  =========================================
``WORKER_DB_POOL_MIN``      ``1``    Connections kept warm at startup.
``WORKER_DB_POOL_MAX``      ``8``    Hard cap on concurrent checkouts.
``WORKER_DB_POOL_TIMEOUT``  ``30``   Seconds to wait for a free conn.
==========================  =========================================

API contract is preserved — call sites continue to use
``with connect() as conn:`` exactly as before. The pool's
``connection()`` context manager handles commit/rollback on exit and
returns the connection to the pool.
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def get_dsn() -> str:
    dsn = (
        os.environ.get("XYZO_DB_DSN")
        or os.environ.get("XYZO_DB_URL")
        or os.environ.get("DATABASE_URL")
        or os.environ.get("NEWSIUM_DB_DSN")
    )
    if not dsn:
        raise RuntimeError(
            "XYZO_DB_DSN is required "
            "(XYZO_DB_URL, DATABASE_URL, and NEWSIUM_DB_DSN are also accepted)"
        )
    return dsn


_POOL_MIN: int = int(os.environ.get("WORKER_DB_POOL_MIN", "1"))
_POOL_MAX: int = int(os.environ.get("WORKER_DB_POOL_MAX", "8"))
_POOL_CHECKOUT_TIMEOUT: int = int(os.environ.get("WORKER_DB_POOL_TIMEOUT", "30"))

# Per-connection kwargs applied at connection-creation time. ``row_factory``
# + ``options`` mirror the original psycopg.connect() call so call sites
# see no behavioural change. ``connect_timeout`` covers the initial
# TCP+auth roundtrip; for an already-pooled connection it is irrelevant.
_POOL_KWARGS: dict = {
    "row_factory": dict_row,
    "options": "-c statement_timeout=60000",
    "connect_timeout": 10,
}

_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()


def _get_pool() -> ConnectionPool:
    """Return the module-level pool, creating it on first call (thread-safe).

    The pool is opened eagerly so that the first checkout does not pay
    the full min_size connection-setup cost.
    """
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            pool = ConnectionPool(
                conninfo=get_dsn(),
                min_size=_POOL_MIN,
                max_size=_POOL_MAX,
                timeout=_POOL_CHECKOUT_TIMEOUT,
                kwargs=_POOL_KWARGS,
                open=False,
            )
            # ``open=True`` would be simpler, but raising on DSN error at
            # import time is more useful than doing it on the first
            # checkout (which may be deep inside a cron job at 3 AM).
            pool.open(wait=True, timeout=10.0)
            _pool = pool
    return _pool


@contextmanager
def connect(autocommit: bool = False, timeout: int = 10) -> Iterator[psycopg.Connection]:
    """Yield a pooled psycopg3 connection.

    Backward-compatible: call sites use ``with connect() as conn:`` exactly
    as before. The pool's ``connection()`` context manager handles
    commit/rollback on exit and returns the connection to the pool.

    Args:
        autocommit: If True, the yielded connection is set to autocommit
            mode (no implicit transaction; the caller's statements are
            committed individually).
        timeout: Per-call checkout timeout in seconds. Overrides the
            pool-level default for this call only. Falls back to a
            ``psycopg_pool.PoolTimeout`` if no connection becomes
            available within the window.
    """
    pool = _get_pool()
    with pool.connection(timeout=timeout) as conn:
        # ``autocommit`` is a per-connection attribute; set it after
        # checkout. The pool's __exit__ performs commit/rollback only for
        # non-autocommit connections (a no-op in autocommit mode), so
        # setting it here is safe.
        conn.autocommit = autocommit
        yield conn


def pool_stats() -> dict:
    """Return a snapshot of the connection pool for monitoring.

    Cheap — psycopg_pool's ``get_stats()`` is in-memory. Safe to call from
    any thread. Intended for /metrics endpoints and cron-time diagnostics.
    """
    pool = _get_pool()
    s = pool.get_stats()
    return {
        "min_size": s.get("pool_min", _POOL_MIN),
        "max_size": s.get("pool_max", _POOL_MAX),
        "pool_size": s.get("pool_size", 0),
        "available": s.get("pool_available", 0),
        "requests_num": s.get("requests_num", 0),
        "requests_waiting": s.get("requests_waiting", 0),
        "connections_num": s.get("connections_num", 0),
        "usage_ms": s.get("usage_ms", 0),
    }


def close_pool() -> None:
    """Close the pool and release all connections. Idempotent.

    Mostly useful in tests; the worker process exits at the end of each
    cycle and lets the OS reclaim sockets, so we don't bother wiring this
    into an atexit hook in production.
    """
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None
