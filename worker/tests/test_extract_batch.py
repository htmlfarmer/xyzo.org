#!/usr/bin/env python3
"""
Tests for worker.extract._batch_update_articles — the Q6 fix
(README, 2026-11-01).

What was wrong, and what these pin:

  THE WHOLE BATCH RAN IN ONE TRANSACTION. There was no commit inside the
  loop — the pool committed when the `with connect()` block exited. So:

    (a) one failed statement rolled back EVERY row of the batch. The
        nightly failed at extract.py:721 on 10-29 with QueryCanceled and
        threw away hours of Gemma extraction;
    (b) the transaction stayed open for the entire batch, holding row
        locks on news_articles throughout. That is what starves OTHER
        writers into tripping statement_timeout themselves, and it
        blocks autovacuum — the same shape learn.py already fixed on
        2026-09-26 for update_source_keywords() ("commit per source …
        rolling back 4,000 sources of work if one row failed").

The fix commits per row and scopes a 300 s statement_timeout to these
statements only.

NOTE ON THE TIMEOUT VALUE: a single UPDATE here is bounded work (~1.1 s —
the trg_detect_cities trigger scans 8,264 world_cities rows with four
LIKE patterns and no usable index), so 60 s was never about the query
being slow. It was about WAITING on a lock or on a swapping box. 300 s
absorbs that contention; it still fails loudly if a row never finishes.

Run with: python -m pytest worker/tests/test_extract_batch.py -v
"""
import psycopg
import pytest

from worker.db import connect
from worker.extract import _batch_update_articles

PREFIX = "https://test-extract-batch.example/"


def _ext(summary: str, entities=None) -> dict:
    return {
        "summary": summary,
        "location_text": "Testville",
        "event_type": "test",
        "entities": ["ok"] if entities is None else entities,
        "topic_tags": ["testing"],
    }


def _seed(n: int) -> list[int]:
    ids: list[int] = []
    with connect() as conn, conn.cursor() as cur:
        for i in range(n):
            cur.execute(
                "INSERT INTO news_articles (url, title, status, summary) "
                "VALUES (%s, %s, 'extracted', NULL) RETURNING id",
                (f"{PREFIX}{i}-{__import__('uuid').uuid4()}", f"extract batch test {i}"),
            )
            ids.append(cur.fetchone()["id"])
        conn.commit()
    return ids


def _summary(article_id: int):
    with connect() as conn:
        row = conn.execute(
            "SELECT summary FROM news_articles WHERE id = %s", (article_id,)
        ).fetchone()
        conn.commit()
    return row["summary"] if row else None


def _timeout() -> str:
    with connect() as conn:
        val = conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"]
        conn.commit()
    return val


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    with connect() as conn:
        conn.execute("DELETE FROM news_articles WHERE url LIKE %s", (PREFIX + "%",))
        conn.commit()


def test_one_failed_row_does_not_discard_the_batch():
    """The core regression: commit per row.

    Row 2 raises (malformed array literal) and must NOT take rows 1 and
    3 down with it — and row 3 must never have run at all.
    """
    a, b, c = _seed(3)
    updates = [
        (a, _ext("row one committed"), "extracted"),
        (b, _ext("row two blows up", entities="this is not an array"), "extracted"),
        (c, _ext("row three never runs"), "extracted"),
    ]

    with pytest.raises(psycopg.errors.InvalidTextRepresentation):
        _batch_update_articles(updates)

    # (a) the row written BEFORE the failure survives the failure.
    assert _summary(a) == "row one committed"
    # (b) the failure happened at row 2 …
    assert _summary(b) is None
    # … and row 3 was never attempted.
    assert _summary(c) is None


def test_a_clean_batch_writes_every_row():
    ids = _seed(2)
    _batch_update_articles([
        (ids[0], _ext("first"), "extracted"),
        (ids[1], _ext("second"), "extracted"),
    ])
    assert _summary(ids[0]) == "first"
    assert _summary(ids[1]) == "second"


def test_statement_timeout_does_not_leak_to_other_pool_users():
    """SET must be undone, or every later statement on that pooled
    connection silently runs at 300 s instead of the pool's 60 s.

    WORKER_DB_POOL_MIN defaults to 1, so the checkout after the batch is
    the same connection the batch used — if RESET were missing this
    would read '5min'.
    """
    before = _timeout()
    ids = _seed(1)
    _batch_update_articles([(ids[0], _ext("timeout probe"), "extracted")])
    after = _timeout()

    assert before == "1min", f"pool default changed unexpectedly: {before}"
    assert after == before, f"timeout leaked: {before} -> {after}"


def test_timeout_is_raised_for_the_batch_itself():
    """The other half of Q6: these statements get MORE than 60 s.

    Spied on at the CURSOR, because that is where `SET LOCAL` is issued
    (the function deliberately does not touch conn.execute for it).
    """
    seen: list[str] = []
    ids = _seed(1)

    import worker.extract as extract_mod

    real_connect = extract_mod.connect

    class SpyCursor:
        def __init__(self, cur):
            self._cur = cur
        # `with connect() as conn, conn.cursor() as cur:` — the cursor is
        # used as a context manager, so the wrapper must support it too.
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return self._cur.__exit__(*exc)
        def execute(self, sql, *a, **k):
            if "statement_timeout" in sql:
                seen.append(sql)
            return self._cur.execute(sql, *a, **k)
        def __getattr__(self, name):
            return getattr(self._cur, name)

    class SpyConn:
        def __init__(self, mgr):
            self._mgr = mgr
        def __enter__(self):
            self._conn = self._mgr.__enter__()
            return self
        def __exit__(self, *exc):
            return self._mgr.__exit__(*exc)
        def cursor(self, *a, **k):
            return SpyCursor(self._conn.cursor(*a, **k))
        def execute(self, sql, *a, **k):
            if "statement_timeout" in sql:
                seen.append(sql)
            return self._conn.execute(sql, *a, **k)
        def commit(self):
            return self._conn.commit()
        def __getattr__(self, name):
            return getattr(self._conn, name)

    extract_mod.connect = lambda *a, **k: SpyConn(real_connect(*a, **k))
    try:
        _batch_update_articles([(ids[0], _ext("spy probe"), "extracted")])
    finally:
        extract_mod.connect = real_connect

    assert any("SET LOCAL statement_timeout" in s for s in seen), (
        f"batch did not raise the timeout with SET LOCAL: {seen!r}"
    )
    assert any("300s" in s for s in seen), f"timeout not raised to 300s: {seen!r}"
    # A bare (non-LOCAL) SET would survive the commit and silently leave
    # every later statement on that pooled connection at 300 s.
    assert not any(
        s.lstrip().upper().startswith("SET STATEMENT_TIMEOUT") for s in seen
    ), f"non-LOCAL SET would leak: {seen!r}"
    # The row itself must still have been written through the spy.
    assert _summary(ids[0]) == "spy probe"
