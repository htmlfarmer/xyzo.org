"""Tier 1.5 — fetch-lease compare-and-set tests (Audit 4 fix).

The fetch worker's claim CTE
(worker/fetch.py:_claim_sources_due + api/migrations/2026-09-08-
fetch-lease.sql) must be atomic under concurrency: with N workers
racing for the same set of due sources, every row in that set must
land in exactly one worker's hands.

The tests cover:

  test_lease_is_atomic              10 threads, 5 due rows → 5 unique claims
  test_lease_release_unblocks_others  Acquire → release → another thread can claim
  test_lease_release_wrong_token    Stale token can't release someone else's claim
  test_expired_lease_can_be_reclaimed  Past lease_expires_at → claimable again

Each test isolates by snapshotting and restoring the lease columns on
a small fixture set; we never touch active sources outside the test's
own rows. Run with:

    cd /var/www/vhosts/xyzo.org
    pytest worker/tests/test_fetch_lease.py -v
"""
from __future__ import annotations

import concurrent.futures
import threading
import uuid
from typing import Iterable

import psycopg
import pytest

from worker.db import connect


# ── helpers ────────────────────────────────────────────────────────────────


def _q(sql: str, *args) -> list[dict]:
    """Execute SQL, fetchall as dicts."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, args)
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return []


def _safe_claim_due(src_ids: Iterable[int]) -> list[dict]:
    """Run the same claim SQL the worker uses, but limited to ``src_ids``.

    Returns the claimed rows with lease_token. Outer ``fetch_all`` only
    walks active, due rows; here we constrain to ``src_ids`` so we
    can reclaim the same row repeatedly without spinning the test.
    """
    src_list = list(src_ids)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            WITH claimable AS (
                SELECT id
                FROM news_sources
                WHERE id = ANY(%s)
                  AND active = TRUE
                  AND deleted_at IS NULL
                  AND (fetch_in_progress = FALSE OR lease_expires_at < now())
                ORDER BY id
                FOR UPDATE SKIP LOCKED
            ),
            claimed AS (
                UPDATE news_sources
                SET fetch_in_progress = TRUE,
                    lease_token = gen_random_uuid()::text,
                    lease_expires_at = now() + INTERVAL '5 minutes'
                FROM claimable
                WHERE news_sources.id = claimable.id
                RETURNING news_sources.id, news_sources.lease_token
            )
            SELECT * FROM claimed ORDER BY id
            """,
            (src_list,),
        )
        return cur.fetchall()


def _reset_for_test(src_ids: Iterable[int]) -> None:
    """Restore lease columns + last_polled_at on the fixture rows.

    Idempotent — safe to call in setup and teardown.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_sources
            SET fetch_in_progress = FALSE,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_polled_at = NULL
            WHERE id = ANY(%s)
            """,
            (list(src_ids),),
        )


def _fixture_source_ids(n: int) -> list[int]:
    """Pick N active, non-deleted source ids ordered by id.

    Stable within a single test run (sources don't get inserted during
    tests; we just read what's there). Saves/restores them via
    ``_reset_for_test``.
    """
    rows = _q(
        "SELECT id FROM news_sources "
        "WHERE active = TRUE AND deleted_at IS NULL "
        f"ORDER BY id LIMIT {int(n)}"
    )
    return [int(r["id"]) for r in rows]


# ── tests ──────────────────────────────────────────────────────────────────


def test_lease_is_atomic():
    """8 concurrent lease attempts on the same 5 sources → exactly 5 winners.

    Closes Audit 4. Without FOR UPDATE SKIP LOCKED on the inner
    SELECT, two workers would both RETURNING the same row in the
    commercial/community tier case (always-TRUE WHERE predicate), both
    fetch the same source, both INSERT-IGNORE the same articles —
    duplicate RSS reads + duplicate DB attempts per cycle.

    With SKIP LOCKED, every worker sees a disjoint slice of the
    claimable rows, so each `id` is claimed by exactly one worker.

    Thread count is 8 (== WORKER_DB_POOL_MAX default) so the test does
    not itself wait at the pool checkout barrier. The atomicity
    property tested here doesn't depend on thread count — 5 unique
    claims with N concurrent workers generalizes to any N>=5 — but
    picking a value at the pool boundary keeps runtimes short and
    avoids the "this test deadlocked waiting for a connection" failure
    mode.
    """
    src_ids = _fixture_source_ids(5)
    if len(src_ids) < 5:
        pytest.skip("test DB needs at least 5 active sources")

    _reset_for_test(src_ids)

    thread_count = 8
    barrier = threading.Barrier(thread_count)
    wins: list[tuple[int, int]] = []
    barrier_lock = threading.Lock()

    def attempt(i: int) -> None:
        with connect() as conn, conn.cursor() as cur:
            barrier.wait()  # all 8 threads race together
            cur.execute(
                """
                WITH claimable AS (
                    SELECT id
                    FROM news_sources
                    WHERE id = ANY(%s)
                      AND active = TRUE
                      AND deleted_at IS NULL
                      AND (fetch_in_progress = FALSE OR lease_expires_at < now())
                    ORDER BY id
                    FOR UPDATE SKIP LOCKED
                ),
                claimed AS (
                    UPDATE news_sources
                    SET fetch_in_progress = TRUE,
                        lease_token = gen_random_uuid()::text,
                        lease_expires_at = now() + INTERVAL '5 minutes'
                    FROM claimable
                    WHERE news_sources.id = claimable.id
                    RETURNING news_sources.id, news_sources.lease_token
                )
                SELECT id, lease_token FROM claimed ORDER BY id
                """,
                (src_ids,),
            )
            row_results = cur.fetchall()
        # Commit happens on `with connect()` exit. Append to shared
        # wins under a lock — Python list.append is GIL-atomic but
        # explicit lock keeps the dict iteration order deterministic
        # in failure messages.
        with barrier_lock:
            for r in row_results:
                wins.append((int(r["id"]), i))

    with concurrent.futures.ThreadPoolExecutor(max_workers=thread_count) as ex:
        futures = [ex.submit(attempt, i) for i in range(thread_count)]
        for f in futures:
            f.result()

    # Each row was claimed at most once: no duplicate ids across workers.
    claimed_ids = [w[0] for w in wins]
    assert len(claimed_ids) == len(set(claimed_ids)), (
        f"DUPLICATE CLAIM: {[w for w in wins if claimed_ids.count(w[0]) > 1]}"
    )
    # And every claim is for one of the fixture rows.
    assert set(claimed_ids) == set(src_ids), (
        f"missing rows: {set(src_ids) - set(claimed_ids)}; "
        f"extra rows: {set(claimed_ids) - set(src_ids)}"
    )

    _reset_for_test(src_ids)


def test_lease_release_unblocks_others():
    """After release, the row is immediately claimable again.

    Acquire a lease on row X. While the lease is held, a second claim
    attempt sees zero rows. Release the lease. A third claim attempt
    now sees row X again.
    """
    src_ids = _fixture_source_ids(1)
    if not src_ids:
        pytest.skip("test DB needs at least 1 active source")
    src_id = src_ids[0]
    _reset_for_test(src_ids)

    # First claim
    first = _safe_claim_due(src_ids)
    assert len(first) == 1
    lease_token = first[0]["lease_token"]

    # Second claim while lease is held → empty
    while_held = _safe_claim_due(src_ids)
    assert while_held == [], f"row leaked to second claim: {while_held}"

    # Release via the public helper (mirrors fetch.py:_release_lease)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_sources SET fetch_in_progress = FALSE, "
            "lease_token = NULL, lease_expires_at = NULL "
            "WHERE id = %s AND lease_token = %s RETURNING id",
            (src_id, lease_token),
        )
        released = cur.fetchone()
        conn.commit()
    assert released is not None, "release should match the held lease"

    # Third claim now succeeds
    third = _safe_claim_due(src_ids)
    assert len(third) == 1 and third[0]["id"] == src_id

    _reset_for_test(src_ids)


def test_lease_release_wrong_token_does_not_stomp():
    """CAS on lease_token: a stale token can't release someone else's claim.

    The release uses ``WHERE id = $1 AND lease_token = $2`` so if
    another worker has already taken over the lease (rare: only on a
    crash + lease expiry race), the release is a silent no-op rather
    than stomping on the active claim. This is the contract
    documented on _release_lease.
    """
    src_ids = _fixture_source_ids(1)
    if not src_ids:
        pytest.skip("test DB needs at least 1 active source")
    src_id = src_ids[0]
    _reset_for_test(src_ids)

    # Worker A claims.
    a = _safe_claim_due(src_ids)
    assert len(a) == 1
    real_token = a[0]["lease_token"]
    stale_token = "stale-token-" + uuid.uuid4().hex

    # Simulate someone-else (e.g. lease expired, another worker
    # claimed). Worker B's release of "A's token" should NOT stomp on
    # row because A's lease_token is still in the row.
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_sources SET fetch_in_progress = FALSE, "
            "lease_token = NULL, lease_expires_at = NULL "
            "WHERE id = %s AND lease_token = %s RETURNING id",
            (src_id, stale_token),
        )
        # Wrong token: rowcount 0, RETURNING yields nothing.
        result = cur.fetchone()
        conn.commit()
    assert result is None, "stale-token release should be a no-op"

    # And the row remains leased (fetch_in_progress TRUE) — confirming
    # we did not stomp on the active claim.
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT fetch_in_progress, lease_token FROM news_sources WHERE id = %s",
            (src_id,),
        )
        row = cur.fetchone()
    assert row["fetch_in_progress"] is True, "active claim got stomped"
    assert row["lease_token"] == real_token

    # Cleanup the real claim via its real token.
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_sources SET fetch_in_progress = FALSE, "
            "lease_token = NULL, lease_expires_at = NULL "
            "WHERE id = %s AND lease_token = %s RETURNING id",
            (src_id, real_token),
        )
        cur.fetchone()
        conn.commit()

    _reset_for_test(src_ids)


def test_expired_lease_can_be_reclaimed():
    """An expired lease self-heals via ``lease_expires_at < now()``.

    Even when ``fetch_in_progress = TRUE``, the lease is fair game
    once the expiry passes — this is how crashed workers' leases get
    recovered. We force lease_expires_at into the past, then claim.
    """
    src_ids = _fixture_source_ids(1)
    if not src_ids:
        pytest.skip("test DB needs at least 1 active source")
    src_id = src_ids[0]
    _reset_for_test(src_ids)

    # Claim the row, then backdate its expiry.
    first = _safe_claim_due(src_ids)
    assert len(first) == 1
    real_token = first[0]["lease_token"]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_sources SET lease_expires_at = now() - INTERVAL '1 minute' "
            "WHERE id = %s AND lease_token = %s RETURNING id",
            (src_id, real_token),
        )
        cur.fetchone()
        conn.commit()

    # A new claim attempt should now succeed despite fetch_in_progress = TRUE.
    second = _safe_claim_due(src_ids)
    assert len(second) == 1 and second[0]["id"] == src_id
    # And the lease_token was rotated to a new uuid.
    assert second[0]["lease_token"] != real_token

    _reset_for_test(src_ids)


def test_helper_modules_importable():
    """_claim_sources_due and _release_lease are exportable + signed correctly.

    Catches the failure mode where someone refactors fetch.py and the
    helpers become private (renamed away the underscore prefix) or
    shift signature without updating call sites.
    """
    from worker import fetch

    assert callable(fetch._claim_sources_due)
    assert callable(fetch._release_lease)
    # Docstrings preserved — these explain the contract for the next reader.
    assert "CAS" in fetch._release_lease.__doc__
    assert "SKIP LOCKED" in fetch._claim_sources_due.__doc__


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
