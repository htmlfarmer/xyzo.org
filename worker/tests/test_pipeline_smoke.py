"""Pipeline smoke tests — import-time + one-call coverage for every module in
the ingestion→geocode→cluster chain.

Why this exists (docs/FIX_NOTES_2026-09-26.md §1, docs/CODEBASE_REVIEW_2026-09-26.md §10):
three CRITICAL production bugs ran for DAYS undetected because no test ever
imported or called the affected functions:

  * geocode.upsert_location() NameError (deleted `with` line, Sep 15 → 11 days,
    "Re-evaluate this pin" 100% broken, new cities unbindable)
  * web_scraper.py tuple-unpack of RobotsVerdict (951 'web' sources → 0 articles)
  * place_disambiguation.py "\\mexico" bad escape → re.error swallowed,
    watchlist silently skipped for El-Paso-class inputs

These tests are deliberately cheap and network-free: mocked DB/HTTP, AST scans.
Run with the rest of worker/tests/.
"""
from __future__ import annotations

import ast
import inspect
import re
from dataclasses import replace
from unittest.mock import MagicMock, patch

import pytest

PIPELINE_MODULES = [
    "worker.fetch",
    "worker.geocode",
    "worker.extract",
    "worker.auto_categorize",
    "worker.place_disambiguation",
    "worker.cities_text",
    "worker.web_scraper",
    "worker.robots",
    "worker.cluster",
    "worker.density",
    "worker.wiki_geo",
    "worker.re_evaluate",
    "worker.audio_fetch",
    "worker.video_fetch",
    "worker.immediate_discover",
    "worker.learn",
    "worker.story_linker",
]

REGEX_SCAN_MODULES = [
    "worker/place_disambiguation.py",
    "worker/extract.py",
    "worker/auto_categorize.py",
    "worker/cities_text.py",
    "worker/geocode.py",
    "worker/web_scraper.py",
    "worker/fetch.py",
    "worker/cluster.py",
    "worker/density.py",
    "worker/wiki_geo.py",
    "worker/re_evaluate.py",
]

RE_METHODS = {"compile", "search", "match", "fullmatch", "sub", "subn",
              "split", "findall", "finditer"}


class TestModuleImports:
    """Every pipeline module must import cleanly.

    Catches import-time crashes (NameError at module scope, bad regex compiled
    at import, missing symbols) that py_compile-only smokes miss entirely.
    """

    @pytest.mark.parametrize("module_name", PIPELINE_MODULES)
    def test_module_imports(self, module_name):
        import importlib
        mod = importlib.import_module(module_name)
        assert mod is not None


class TestRegexCompilability:
    """Compile every regex literal passed to re.* across the pipeline.

    The '\\mexico' bug (FIX_NOTES 1.4) was a NON-raw string where '\\m' is an
    invalid escape. Watchlist patterns compile at import, but function-body
    inline regexes compile lazily — only when a specific input hits them —
    and the crash was swallowed by `except: pass` upstream. This scan compiles
    them ALL up front, loudly.
    """

    def _scan(self, rel_path: str) -> list[tuple[int, str]]:
        import pathlib
        root = pathlib.Path(__file__).resolve().parents[2]
        src = (root / rel_path).read_text(encoding="utf-8")
        broken: list[tuple[int, str]] = []
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute)
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "re"
                    and func.attr in RE_METHODS):
                continue
            if not node.args:
                continue
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                try:
                    re.compile(first.value)
                except re.error as exc:
                    broken.append((node.lineno, f"{first.value!r} → {exc}"))
        return broken

    @pytest.mark.parametrize("rel_path", REGEX_SCAN_MODULES)
    def test_all_regexes_compile(self, rel_path):
        broken = self._scan(rel_path)
        assert not broken, (
            f"{rel_path}: {len(broken)} regex literal(s) fail to compile: "
            + "; ".join(f"line {ln}: {msg}" for ln, msg in broken)
        )


class TestRobotsVerdictContract:
    """fetch.py and web_scraper.py must consume is_allowed() the SAME way.

    The robots.py refactor changed is_allowed() from a 3-tuple to a
    RobotsVerdict dataclass; fetch.py was fixed, the web_scraper copy missed
    it — TypeError swallowed → every 'web' source scraped 0 articles for
    weeks (FIX_NOTES 1.2 / CODEBASE_REVIEW BUG-2). A tuple-unpack of
    is_allowed() anywhere in the consumers is now a hard test failure.
    """

    def _find_tuple_unpacks(self, rel_path: str) -> list[int]:
        import pathlib
        root = pathlib.Path(__file__).resolve().parents[2]
        tree = ast.parse((root / rel_path).read_text(encoding="utf-8"))
        offenders = []
        for node in ast.walk(tree):
            targets = []
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, (ast.For,)):
                targets = [node.target]
            for target in targets:
                if isinstance(target, ast.Tuple):
                    v = node.value if isinstance(node, ast.Assign) else node.iter
                    if (isinstance(v, ast.Call)
                            and isinstance(v.func, ast.Attribute)
                            and v.func.attr == "is_allowed"):
                        offenders.append(node.lineno)
        return offenders

    @pytest.mark.parametrize("rel_path", ["worker/fetch.py", "worker/web_scraper.py"])
    def test_no_tuple_unpack_of_is_allowed(self, rel_path):
        offenders = self._find_tuple_unpacks(rel_path)
        assert not offenders, (
            f"{rel_path}: lines {offenders} unpack robots.is_allowed() as a "
            "tuple — it returns a RobotsVerdict dataclass (attribute access only)"
        )

    def test_verdict_attributes_consumed_exist(self):
        """Consumers reference .allowed/.crawl_delay_s/.disallowed_path —
        those attrs must still exist on RobotsVerdict."""
        from worker.robots import RobotsVerdict

        v = RobotsVerdict(allowed=True)
        for attr in ("allowed", "crawl_delay_s", "disallowed_path"):
            assert hasattr(v, attr), f"RobotsVerdict lost attribute {attr!r}"

        import pathlib
        root = pathlib.Path(__file__).resolve().parents[2]
        for rel in ("worker/fetch.py", "worker/web_scraper.py"):
            text = (root / rel).read_text()
            assert "verdict.allowed" in text or "is_allowed(" in text

    def test_scrape_source_flows_verdict_and_returns_articles(self):
        """BEHAVIORAL drive of web_scraper.scrape_source() with a REAL
        RobotsVerdict and mocked HTTP. If the tuple-unpack regression (or any
        new swallowed-TypeError class) returns, scrape_source silently yields
        [] and this test goes red."""
        from worker import web_scraper
        from worker.robots import RobotsVerdict

        verdict_allowed = RobotsVerdict(allowed=True, crawl_delay_s=None)
        verdict_denied_article = RobotsVerdict(allowed=False, disallowed_path="/secret")

        robots_stub = MagicMock()
        robots_stub.is_allowed.side_effect = [
            verdict_allowed,            # main page
            verdict_allowed,            # article 1
            verdict_denied_article,     # article 2 (robots-blocked, skipped)
        ]

        main_html = """
        <html><body>
          <a href="/news/2026/09/story-one.html">Story One</a>
          <a href="/news/2026/09/story-two.html">Story Two</a>
        </body></html>
        """
        article_html = """
        <html><head><title>Story One | TestSite</title></head>
        <body><article><h1>Story One</h1>
        <p>{}</p></article></body></html>
        """.format("The quick brown fox jumps over the lazy dog near the city hall. " * 12)

        class FakeResponse:
            # web_scraper now streams with a MAX_FEED_BYTES cap (2026-09-28),
            # so the fake must implement the client.stream() context-manager
            # protocol (.status_code + .iter_bytes), not the old .get()/.text.
            def __init__(self, text, code=200):
                self._text, self.status_code = text, code

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def iter_bytes(self, chunk_size=65536):
                data = self._text.encode("utf-8")
                for i in range(0, len(data), chunk_size):
                    yield data[i:i + chunk_size]

        class FakeClient:
            def __init__(self, **kwargs):  # httpx.Client(timeout=..., headers=...)
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def stream(self, method, url, **kw):
                if url.endswith("story-one.html"):
                    return FakeResponse(article_html)
                if url.endswith("story-two.html"):
                    return FakeResponse(article_html)
                return FakeResponse(main_html)

        # RobotsVerdict must NOT have a crawl delay that triggers sleeps:
        with patch.object(web_scraper, "_robots", robots_stub), \
             patch.object(web_scraper.httpx, "Client", FakeClient), \
             patch.object(web_scraper.time, "sleep", lambda s: None):
            articles = web_scraper.scrape_source("https://example.com/news")

        assert len(articles) >= 1, (
            "scrape_source returned no articles with an allowed robots verdict — "
            "a swallowed exception (the BUG-2 class) is most likely the cause"
        )
        assert articles[0]["title"]
        assert len(articles[0]["body"]) > 100
        # is_allowed called for main page + each candidate article link:
        assert robots_stub.is_allowed.call_count >= 2


class TestUpsertLocation:
    """geocode.upsert_location() must be CALLABLE (BUG-3: the `with connect()
    ... as cur` line was deleted; every call raised NameError since Sep 15,
    breaking new-city binding, Re-evaluate, and audio geocoding). Existing
    tests only ever MOCKED it — they could not catch the crash.

    Uses a mocked connect() so no real rows are written.
    """

    def _mock_conn(self):
        cur = MagicMock()
        cur.fetchone.return_value = {"id": 12345}
        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.cursor.return_value.__enter__.return_value = cur
        return conn, cur

    def test_upsert_location_executes_insert(self):
        from worker import geocode

        loc = {
            "place_name": "Testvillagenotsreal",
            "place_name_normalized": "testvillagenotsreal",
            "country": "Nowhere",
            "lat": 1.234, "lng": 5.678,
            "precision": "city", "confidence": 0.5,
            "osm_id": 999999, "osm_type": "node",
        }
        conn, cur = self._mock_conn()
        with patch.object(geocode, "connect", lambda: conn):
            result = geocode.upsert_location(loc)

        assert result == 12345
        sql_text = cur.execute.call_args[0][0]
        assert "INSERT INTO news_locations" in sql_text
        assert "ON CONFLICT" in sql_text and "RETURNING id" in sql_text

    def test_upsert_location_uses_geography_cast(self):
        """geom must be written as geography via ST_SetSRID(...)::geography —
        drift here silently breaks the /pins/map spatial join."""
        from worker import geocode

        loc = {
            "place_name": "X", "place_name_normalized": "x", "country": "Y",
            "lat": 0.0, "lng": 0.0, "precision": "city", "confidence": 0.0,
            "osm_id": None, "osm_type": None,
        }
        conn, cur = self._mock_conn()
        with patch.object(geocode, "connect", lambda: conn):
            geocode.upsert_location(loc)
        sql_text = cur.execute.call_args[0][0]
        assert "ST_SetSRID" in sql_text and "::geography" in sql_text


class TestReEvaluateWiring:
    """re_evaluate.py's user-corrections flow calls geocode.upsert_location —
    pin the call path exists (BUG-3 blast radius: nn_user_corrections frozen,
    our future training labels blocked)."""

    def test_re_evaluate_imports_and_uses_upsert(self):
        from worker import re_evaluate
        src = inspect.getsource(re_evaluate)
        assert "upsert_location" in src
        assert callable(re_evaluate._re_evaluate_with_ai)


class TestCleanupStaleLeases:
    """cleanup_stale_leases must actually CLEAR seeded stale rows.

    Existing coverage only smoke-tested that the function is callable
    (test_worker_health.py) — seeding nothing and asserting it cleared
    something is the whole point (Sep 20 incident: 1,843 stuck leases).

    SAFETY: runs ONLY against the isolated xyzo_test database. Never against
    the live xyzo DB — clearing leases mid-sweep releases active claims.
    """

    TEST_DSN_FALLBACK = "postgresql://xyzo_app@localhost:5432/xyzo_test"

    def _test_dsn(self) -> str:
        import os
        dsn = os.environ.get("XYZO_TEST_DB_DSN") or self.TEST_DSN_FALLBACK
        if "/xyzo_test" not in dsn:
            raise ValueError(f"refusing to run lease cleanup outside xyzo_test: {dsn}")
        return dsn

    def test_cleanup_clears_seeded_stale_lease(self):
        import os
        import psycopg

        dsn = self._test_dsn()
        try:
            conn = psycopg.connect(dsn, connect_timeout=3, row_factory=psycopg.rows.dict_row)
        except Exception as exc:  # test DB absent on this machine — skip loudly but cleanly
            pytest.skip(f"xyzo_test DB unreachable for lease cleanup test: {exc}")

        try:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO news_sources (name, feed_url, source_type, country, active,
                                          fetch_in_progress, lease_expires_at)
                VALUES ('ZZ TEST STALE LEASE CANARY', 'https://test.invalid/feed',
                        'rss', 'ZZ', FALSE, TRUE, now() - interval '10 minutes')
                RETURNING id
                """
            )
            sid = cur.fetchone()["id"]
            conn.commit()

            cur.execute(
                "SELECT count(*)::int AS n FROM news_sources "
                "WHERE id = %s AND fetch_in_progress AND lease_expires_at < now()", (sid,)
            )
            assert cur.fetchone()["n"] == 1, "seeded stale lease not visible"

            from unittest.mock import patch as _patch
            from worker import fetch as wfetch

            def _test_conn():
                return psycopg.connect(dsn, connect_timeout=3,
                                       row_factory=psycopg.rows.dict_row)

            with _patch.object(wfetch, "connect", _test_conn):
                cleared = wfetch.cleanup_stale_leases()

            assert isinstance(cleared, int) and cleared >= 1

            cur.execute("SELECT fetch_in_progress FROM news_sources WHERE id = %s", (sid,))
            assert cur.fetchone()["fetch_in_progress"] is False, (
                "cleanup_stale_leases left our seeded lease claimed"
            )
        finally:
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM news_sources WHERE name = 'ZZ TEST STALE LEASE CANARY'")
                conn.commit()
            finally:
                conn.close()
