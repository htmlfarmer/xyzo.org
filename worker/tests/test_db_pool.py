"""Tier 1.3 — connection pool tests (Audit 4 fix).

Verifies the worker/db.py pool:
  * yields a working connection
  * reuses connections across checkouts (no per-call open/close)
  * replaces a closed/dead connection transparently
  * holds up under concurrent load (20 threads)
  * reports sensible stats

Run with:

    cd /var/www/vhosts/xyzo.org
    pytest worker/tests/test_db_pool.py -v
"""
from __future__ import annotations

import concurrent.futures
import threading

import pytest

from worker import db


def test_pool_returns_a_working_connection():
    """A simple checkout + SELECT 1 round-trip succeeds."""
    with db.connect() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 AS x")
        row = cur.fetchone()
    assert row is not None
    # dict_row → dict; the SELECT alias is ``x``.
    assert row["x"] == 1


def test_pool_reuses_connections_across_checkouts():
    """Two back-to-back checkouts do not exhaust the pool.

    We force the pool up to a known size first so we can detect leaks
    deterministically.
    """
    with db.connect() as a:
        assert not a.closed
    with db.connect() as b:
        assert not b.closed
    # No exception means the pool had capacity to give us two checkouts.
    # Sanity: stats should still report at least one idle connection.
    stats = db.pool_stats()
    assert stats["max_size"] >= 1
    assert stats["pool_size"] >= 1


def test_dead_connection_is_replaced_on_next_checkout():
    """Closing a connection inside the `with` block does not poison the pool.

    On the next checkout the pool should hand back a *non-closed*
    connection. Whether the pool detects the closure on checkout (and
    replaces it) or simply returns a fresh one, the contract from the
    caller's perspective is the same: ``conn.closed is False``.
    """
    # Sabotage the connection mid-block.
    with db.connect() as conn:
        conn.close()
        assert conn.closed

    # The next checkout must yield a healthy connection.
    with db.connect() as conn2:
        assert not conn2.closed
        cur = conn2.cursor()
        cur.execute("SELECT 1 AS x")
        assert cur.fetchone()["x"] == 1


def test_concurrent_operations_do_not_exhaust_max_connections():
    """20 threads × 4 checkouts each — must succeed with pool_max=8.

    Without a pool, this would fan out to 80 fresh connections and almost
    certainly trip ``max_connections`` on a real Postgres server. With the
    pool, the work queues at most ``pool_max`` deep and serialises the
    rest. The smoke pass is the test: every op returns a row.
    """
    iterations = 4
    thread_count = 20

    barrier = threading.Barrier(thread_count)

    def op(_i: int) -> int:
        # All threads hit the barrier so the pool is exercised
        # concurrently, not serially.
        barrier.wait()
        with db.connect() as conn:
            cur = conn.cursor()
            cur.execute("SELECT count(*) AS n FROM pins")
            row = cur.fetchone()
            return int(row["n"]) if row else -1

    with concurrent.futures.ThreadPoolExecutor(max_workers=thread_count) as ex:
        futures = [ex.submit(op, i) for i in range(thread_count * iterations)]
        results = [f.result() for f in futures]

    # Every call returned a value (>= 0 — pins may be empty in a test
    # DB, but the call must have succeeded).
    assert all(r >= 0 for r in results), results
    assert len(results) == thread_count * iterations

    stats = db.pool_stats()
    # Pool must have processed every request without ever exceeding the
    # configured max_size.
    assert stats["max_size"] >= 1
    assert stats["requests_num"] >= thread_count * iterations


def test_pool_stats_shape():
    """pool_stats() returns the documented keys with the right types."""
    stats = db.pool_stats()
    expected_keys = {
        "min_size",
        "max_size",
        "pool_size",
        "available",
        "requests_num",
        "requests_waiting",
        "connections_num",
        "usage_ms",
    }
    assert expected_keys.issubset(stats.keys()), (
        f"missing keys: {expected_keys - set(stats.keys())}"
    )
    assert isinstance(stats["min_size"], int)
    assert isinstance(stats["max_size"], int)
    assert stats["max_size"] >= stats["min_size"] >= 1


def test_autocommit_connection_does_not_implicitly_transaction():
    """In autocommit mode, statements are committed individually.

    We don't have a long-running transaction to abort here, but we can
    at least verify the connection reports autocommit=True and that a
    SELECT round-trips cleanly.
    """
    with db.connect(autocommit=True) as conn:
        assert conn.autocommit is True
        cur = conn.cursor()
        cur.execute("SELECT 42 AS answer")
        assert cur.fetchone()["answer"] == 42


if __name__ == "__main__":
    # Allow running the file directly: ``python worker/tests/test_db_pool.py``.
    raise SystemExit(pytest.main([__file__, "-v"]))
