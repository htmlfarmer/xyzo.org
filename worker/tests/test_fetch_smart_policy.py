"""Tests for the smart-scheduling layer added 2026-09-26:

1. _truncate_feed_body / _bounded_get — the size-cap + salvage-parse path
   (protects the 1G-MemoryMax worker from giant feeds, "stream and parse
   wiser" requirement)
2. Value-weighted exponential backoff math in update_source (1d→2d→4d→8d,
   reliability_score divides, 4 h floor) — runs against xyzo_test ONLY
3. CLAIM_SQL next_retry_at gate — a backed-off source must not be claimable

No production DB writes anywhere (dsn guarded by '/xyzo_test').
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

TEST_DSN = os.environ.get("XYZO_TEST_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo_test")


def _test_connect():
    import psycopg
    assert "/xyzo_test" in TEST_DSN, "refusing non-test DB"
    return psycopg.connect(TEST_DSN, connect_timeout=3, row_factory=psycopg.rows.dict_row)


class _CommitOnly:
    """psycopg3 closes a Connection when used as a `with` context — so to
    patch fetch.connect() while keeping the test connection alive, hand out
    a context wrapper that only commits/rolls back."""

    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        return self._conn

    def __exit__(self, exc_type, exc, tb):
        if exc_type:
            self._conn.rollback()
        else:
            self._conn.commit()
        return False


# ── 1. Bounded parse / size cap ─────────────────────────────────────────────

class TestTruncateFeedBody:
    def test_rss_salvages_whole_items(self):
        from worker.fetch import _truncate_feed_body

        items = b"".join(f"<item><title>i{n}</title></item>".encode() for n in range(100))
        body = b"<rss><channel>" + items + b"<item><title>cuto"  # truncated mid-item
        out = _truncate_feed_body(body)
        assert out.endswith(b"</item></channel></rss>")
        assert out.count(b"<item>") == 100  # partial 101st dropped

    def test_atom_salvages(self):
        from worker.fetch import _truncate_feed_body

        entries = b"".join(f"<entry><id>{n}</id></entry>".encode() for n in range(40))
        body = b"<feed>" + entries + b"<entry><id>cut"
        out = _truncate_feed_body(body)
        assert out.endswith(b"</entry></feed>")
        assert out.count(b"<entry>") == 40

    def test_no_complete_item_returns_empty(self):
        from worker.fetch import _truncate_feed_body

        assert _truncate_feed_body(b"<rss><channel><item><title>nope") == b""

    def test_small_feed_parse_unchanged(self):
        """feedparser must extract everything from a salvaged prefix that
        contains real items (end-to-end of cap+truncate+parse)."""
        import feedparser
        from worker.fetch import _truncate_feed_body

        items = b"".join(
            f"<item><title>Story {n}</title><pubDate>Tue, 22 Sep 2026 21:00:0{6 - (n % 7)} GMT</pubDate></item>".encode()
            for n in range(500)
        )
        body = b"<rss><channel><title>Big</title>" + items + b"<item><title>partial"
        parsed = feedparser.parse(_truncate_feed_body(body))
        assert len(parsed.entries) == 500


class TestBoundedGet:
    class _Resp:
        def __init__(self, status, chunks, headers=None):
            self.status_code = status
            self._chunks = chunks
            self.headers = headers or {}

        def iter_bytes(self):
            yield from self._chunks

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class _Client:
        def __init__(self, resp):
            self._resp = resp

        def stream(self, method, url, **kw):
            import httpx, inspect
            allowed = set(inspect.signature(httpx.Client.stream).parameters)
            bad = set(kw) - allowed
            assert not bad, f"kwargs not accepted by httpx stream(): {bad}"
            assert kw.get("follow_redirects") is True, "redirects must be followed"
            return self._resp

    def test_redirect_cap_lives_on_client_not_stream(self):
        """httpx.Client.stream() does NOT accept max_redirects — passing it
        raised TypeError on every fetch and silently zeroed ingestion
        (2026-09-26 outage). The cap must be on the Client constructor."""
        import inspect
        import worker.fetch as f

        # fetch_host_group is a closure inside fetch_all, so read fetch_all's source
        client_src = inspect.getsource(f.fetch_all)
        assert "max_redirects=6" in client_src
        stream_src = inspect.getsource(f._bounded_get)
        assert "max_redirects" not in stream_src

    def test_oversized_body_capped_and_salvaged(self, monkeypatch):
        import worker.fetch as f
        monkeypatch.setattr(f, "MAX_FEED_BYTES", 2000)

        items = b"".join(f"<item><t>{n}</t></item>".encode() for n in range(1000))
        body = b"<rss><channel>" + items
        resp = self._Resp(200, [body[i:i + 1024] for i in range(0, len(body), 1024)])
        status, headers, out = f._bounded_get(self._Client(resp), "https://x/feed", {})
        assert status == 200
        assert out is not None and len(out) < 4000
        assert out.endswith(b"</item></channel></rss>")

    def test_error_status_short_circuits(self):
        from worker.fetch import _bounded_get

        resp = self._Resp(403, [])
        status, _, body = _bounded_get(self._Client(resp), "u", {})
        assert status == 403 and body is None


class TestBatchLimitedClaims:
    """2026-09-28: the bulk claim used to lease the ENTIRE due sweep (~2,400
    sources) for 5 minutes while the sweep took 40–60 min — leases expired
    mid-run and got re-claimed (thrashing). Claims must stay batch-limited."""

    def test_claim_sql_has_limit(self):
        import worker.fetch as f

        assert "LIMIT" in f.CLAIM_SQL, "CLAIM_SQL must cap claims per batch"
        assert str(f.CLAIM_BATCH_SIZE) in f.CLAIM_SQL, (
            "CLAIM_SQL LIMIT must be the configured batch size"
        )
        # LIMIT must sit inside the claimable CTE (before FOR UPDATE SKIP
        # LOCKED), not after the outer SELECT.
        claimable = f.CLAIM_SQL.split("claimable AS", 1)[1]
        assert claimable.index("LIMIT") < claimable.index("FOR UPDATE SKIP LOCKED")

    def test_default_batch_size_is_bounded(self):
        import worker.fetch as f

        assert 0 < f.CLAIM_BATCH_SIZE <= 500, (
            "default claim batch must be small enough that one batch's "
            "leases stay valid inside LEASE_TTL_S-scale windows"
        )

    def test_fetch_all_reclaims_in_a_loop(self):
        import inspect
        import worker.fetch as f

        src = inspect.getsource(f.fetch_all)
        assert "while True:" in src, "fetch_all must re-claim after each batch"
        assert "_run_batch" in src, "batch processing must run per claim cycle"
        assert src.index("_claim_sources_due") < src.index("_run_batch(fresh)"), (
            "each batch must be claimed immediately before it is fetched"
        )


class TestSweepTermination:
    """2026-09-29 outage: `fetch_all()` exited only when a claim returned
    fewer than CLAIM_BATCH_SIZE rows. RECENT_SUCCESS_WINDOW_S (300 s) refills
    the claimable pool faster than the ~3,700-source fleet can be swept, so
    that exit was unreachable. fetch_all() never returned -> run.py (which
    calls fetch BEFORE auto_categorize/geocode/cluster) never got past step 1
    -> 75k articles stranded at status='pending' with no coordinates while
    the same sources were re-polled 5x/hour."""

    FLEET = 60   # distinct source ids in the fake claimable pool
    BATCH = 20   # deliberately a full batch, so the old exit never fires

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, *a, **k):
            pass

        def fetchone(self):
            return {"id": -1}

        def fetchall(self):
            return []

    class _Conn:
        def cursor(self):
            return TestSweepTermination._Cursor()

        def commit(self):
            pass

        def rollback(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class _Verdict:
        allowed = True
        crawl_delay_s = 0
        disallowed_path = None
        note = ""

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    @staticmethod
    def _src(i):
        return {
            "id": i, "name": f"s{i}", "feed_url": f"https://host{i}.test/feed",
            "source_type": "rss", "etag": None, "last_modified": None,
            "lease_token": f"tok-{i}", "tier": "commercial",
            "seconds_since_success": 9999,
        }

    def _drive(self, monkeypatch, max_batches):
        """Run fetch_all() against a claimable pool that NEVER drains.

        Every claim returns a full batch of ids, walking the fleet and then
        wrapping -- exactly the production condition that made the old
        `len(sources) < CLAIM_BATCH_SIZE` exit unreachable. `max_batches` is
        a tripwire: if fetch_all() claims more than that, it has not
        terminated and the test fails instead of hanging.
        """
        import worker.fetch as f

        claims = {"n": 0}
        fetched = []

        def fake_claim(cur):
            claims["n"] += 1
            assert claims["n"] <= max_batches, "fetch_all() did not terminate"
            start = ((claims["n"] - 1) * self.BATCH) % self.FLEET
            ids = [(start + k) % self.FLEET + 1 for k in range(self.BATCH)]
            return [self._src(i) for i in ids]

        monkeypatch.setattr(f, "connect", lambda *a, **k: self._Conn())
        monkeypatch.setattr(f, "_claim_sources_due", fake_claim)
        monkeypatch.setattr(f, "MIN_FETCH_INTERVAL_S", 0.0)
        monkeypatch.setattr(f, "CLAIM_BATCH_SIZE", self.BATCH)
        # raising=False: on the pre-fix tree this constant does not exist yet,
        # and the test must fail on loop behaviour, not on an AttributeError.
        monkeypatch.setattr(f, "FETCH_MAX_CLAIMED_PER_SWEEP", self.FLEET * 4,
                            raising=False)
        monkeypatch.setattr(f, "RobotsCache", lambda **k: type(
            "R", (), {"is_allowed": staticmethod(lambda u: self._Verdict()),
                      "persist_to_db": staticmethod(lambda *a, **k: None)})())
        def fake_fetch_one(client, src):
            fetched.append(src["id"])
            return [], {"_status_code": 200, "last_success_at": "x"}

        monkeypatch.setattr(f, "fetch_one", fake_fetch_one)
        monkeypatch.setattr(f, "insert_articles", lambda arts, sid: 0)
        monkeypatch.setattr(f, "update_source", lambda *a, **k: None)
        monkeypatch.setattr(f.httpx, "Client", self._Client)

        return f.fetch_all(limit_per_source=None), fetched, claims["n"]

    def test_terminates_when_claimable_pool_never_drains(self, monkeypatch):
        """The regression itself: full batches forever must still return."""
        summary, fetched, claims = self._drive(
            monkeypatch, max_batches=self.FLEET // self.BATCH + 3)

        assert summary["errors"] == 0
        # One pass over the fleet, then stop on the first wrapped claim.
        assert len(fetched) == self.FLEET, (
            f"sweep should cover the fleet exactly once, got {len(fetched)}")
        assert claims == self.FLEET // self.BATCH + 1, (
            "must stop on the first claim that yields no unseen source")

    def test_no_source_polled_twice_in_one_sweep(self, monkeypatch):
        _, fetched, _ = self._drive(
            monkeypatch, max_batches=self.FLEET // self.BATCH + 3)
        assert len(fetched) == len(set(fetched)), (
            "a source was re-polled inside a single sweep")

    def test_termination_guards_present_in_source(self):
        import inspect
        import worker.fetch as f

        src = inspect.getsource(f.fetch_all)
        assert "seen" in src, "fetch_all must track ids it already polled"
        assert '_release_lease(cur, s["id"], s["lease_token"])' in src, (
            "re-claimed sources must have their leases handed back")
        assert "FETCH_MAX_CLAIMED_PER_SWEEP" in src, (
            "a hard per-sweep cap must bound a pathological run")
        assert "if not fresh:" in src, (
            "the loop must break when a claim yields nothing new")

    def test_sweep_cap_is_a_bounded_positive_int(self):
        import worker.fetch as f

        assert 0 < f.FETCH_MAX_CLAIMED_PER_SWEEP <= 100_000
        # big enough to cover the active fleet once, small enough to bound a
        # pathological run
        assert f.FETCH_MAX_CLAIMED_PER_SWEEP >= 4 * f.CLAIM_BATCH_SIZE


# ── 2/3. Backoff math + claim gate — xyzo_test only ──────────────────────────

def _require_test_db():
    try:
        c = _test_connect()
        with c.cursor() as cur:
            cur.execute("SELECT 1 FROM news_sources WHERE next_retry_at IS NOT NULL LIMIT 0")
        c.close()
    except Exception as exc:
        pytest.skip(f"xyzo_test unreachable or missing backoff columns: {exc}")


def _seed(cur, conn, name, *, reliability=0.1, cf=0, next_retry=None, active=True,
          source_type="rss", last_polled=None):
    cur.execute(
        """INSERT INTO news_sources (name, feed_url, source_type, country, active,
                                     consecutive_failures, next_retry_at,
                                     reliability_score, last_polled_at)
           VALUES (%s,%s,%s,'ZZ',%s,%s,%s,%s,%s) RETURNING id""",
        (name, f"https://{name}.test/feed", source_type, active, cf, next_retry,
         reliability, last_polled),
    )
    sid = cur.fetchone()["id"]
    conn.commit()
    return sid


class TestBackoffMath:
    """update_source failure path must set 1d/2d/4d/8d scaled by value."""

    def test_backoff_schedule_and_boost(self):
        _require_test_db()
        import worker.fetch as f

        conn = _test_connect()
        try:
            cur = conn.cursor()
            # low value (reliability 0.1): 0→1d, 1→2d, 2→4d, 3+→8d
            cases_low = {0: (23.0, 25.0), 1: (47.0, 49.0), 2: (95.0, 97.0), 5: (191.0, 193.0)}
            for cf, (lo, hi) in cases_low.items():
                sid = _seed(cur, conn, f"zt-b-{cf}", reliability=0.1, cf=cf)
                with patch.object(f, "connect", lambda c=conn: _CommitOnly(c)):
                    f.update_source(sid, {"last_failure_at": "now()", "error_count_inc": 1})
                conn.commit()
                cur.execute("SELECT next_retry_at, consecutive_failures, error_count FROM news_sources WHERE id=%s", (sid,))
                r = cur.fetchone()
                hrs = (r["next_retry_at"] - datetime.now(timezone.utc)).total_seconds() / 3600
                assert lo < hrs < hi, f"cf={cf}: got {hrs:.2f}h, want {lo}-{hi}h"
                assert r["consecutive_failures"] == cf + 1
                assert r["error_count"] >= 1

            # high value (0.8): divide by 4 → 6h,12h,1d,2d; low(0.5): divide by 2
            sid = _seed(cur, conn, "zt-vip", reliability=0.8, cf=0)
            with patch.object(f, "connect", lambda c=conn: _CommitOnly(c)):
                f.update_source(sid, {"last_failure_at": "now()"})
            conn.commit()
            cur.execute("SELECT next_retry_at FROM news_sources WHERE id=%s", (sid,))
            hrs = (cur.fetchone()["next_retry_at"] - datetime.now(timezone.utc)).total_seconds() / 3600
            assert 5.9 < hrs < 6.1, f"VIP first failure should back off ~6h, got {hrs:.2f}h"

            # success resets everything
            with patch.object(f, "connect", lambda c=conn: _CommitOnly(c)):
                f.update_source(sid, {"last_success_at": "now()"})
            conn.commit()
            cur.execute("SELECT next_retry_at, consecutive_failures FROM news_sources WHERE id=%s", (sid,))
            r = cur.fetchone()
            assert r["next_retry_at"] is None and r["consecutive_failures"] == 0

            # 4h floor even for a VIP in deep failure
            sid = _seed(cur, conn, "zt-floor", reliability=1.0, cf=0)
            with patch.object(f, "connect", lambda c=conn: _CommitOnly(c)):
                for _ in range(6):
                    f.update_source(sid, {"last_failure_at": "now()"})
            conn.commit()
            cur.execute("SELECT next_retry_at FROM news_sources WHERE id=%s", (sid,))
            hrs = (cur.fetchone()["next_retry_at"] - datetime.now(timezone.utc)).total_seconds() / 3600
            assert hrs >= 4.0 - 0.05
        finally:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM news_sources WHERE name LIKE 'zt-%%'")
            conn.commit()
            conn.close()


class TestClaimGate:
    def test_backed_off_source_is_not_claimable(self):
        _require_test_db()
        import worker.fetch as f

        conn = _test_connect()
        try:
            cur = conn.cursor()
            due = _seed(cur, conn, "zt-due", next_retry=None)
            blocked = _seed(cur, conn, "zt-blocked", next_retry=datetime.now(timezone.utc) + timedelta(days=1))
            expired = _seed(cur, conn, "zt-expired", next_retry=datetime.now(timezone.utc) - timedelta(minutes=5))

            # _claim_sources_due takes a cursor directly (fetch_all owns the
            # transaction) — pass our test-DB cursor, no monkeypatch needed.
            try:
                claimed = {row["id"] for row in f._claim_sources_due(cur)}
            except Exception as exc:  # xyzo_test may lack tier_for_url_inline
                pytest.skip(f"claim SQL deps missing in xyzo_test: {exc}")
            conn.commit()
            assert due in claimed
            assert expired in claimed
            assert blocked not in claimed, (
                "backed-off source was claimed — next_retry_at gate regressed"
            )
        finally:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM news_sources WHERE name LIKE 'zt-%%'")
            conn.commit()
            conn.close()
