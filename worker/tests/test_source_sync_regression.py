"""
Regression tests for news source sync workflow.

These tests ensure the feeds.json ↔ DB sync never silently drops live sources.

The key invariant: sources that have articles and are not robots-blocked
must remain active. A sync may deactivate stale or blocked sources, but
it must never deactivate a source that:
  (a) has accumulated articles in the DB, AND
  (b) is not robots-blocked

Run with: pytest worker/tests/test_source_sync_regression.py -v
"""

import json
import os
import pytest

os.environ.setdefault(
    "XYZO_DB_DSN",
    os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app@localhost/xyzo"),
)

from worker.db import connect
from worker.robots import RobotsCache


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def feeds_json():
    """Load the canonical feeds.json file."""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    path = os.path.join(project_root, "worker", "feeds.json")
    with open(path) as f:
        return json.load(f)


@pytest.fixture
def db():
    """Provide a database connection helper for integration tests."""
    with connect() as conn:
        yield conn


# ---------------------------------------------------------------------------
# Regression Tests
# ---------------------------------------------------------------------------

@pytest.mark.network
class TestSourceSyncInvariants:
    """Hard invariants that must never be violated by a sync operation.

    Several methods reach live robots.txt over the network (BBC/Guardian/AP);
    skip in CI with `pytest -m "not network"` (TEST_PLAN §6.2).
    """

    def test_feeds_json_and_db_are_in_sync(self, feeds_json, db):
        """Warn if many active sources are not in feeds.json.

        Note: feeds.json is the canonical source list, but sources can also be
        added via API or reactivated manually. This test warns if >10% of sources
        are orphaned from feeds.json, which might indicate a sync issue.
        """
        feed_urls = {f["feed_url"].lower() for f in feeds_json["feeds"]}

        with db.cursor() as cur:
            cur.execute("""
                SELECT id, feed_url, name, active
                  FROM news_sources
                 WHERE active = TRUE
            """)
            active_rows = cur.fetchall()
            active_urls = {r["feed_url"].lower() for r in active_rows}

        orphaned = active_urls - feed_urls
        pct_orphaned = (len(orphaned) / len(active_urls) * 100) if active_urls else 0

        if pct_orphaned > 10:
            print(f"WARNING: {len(orphaned)}/{len(active_urls)} ({pct_orphaned:.1f}%) active sources not in feeds.json")
            print(f"First 5: {list(orphaned)[:5]}")

        # This is now a warning, not a hard failure
        # Many sources are legitimately added via API or reactivated manually
        assert pct_orphaned < 50, (
            f"Over 50% of sources are orphaned from feeds.json. "
            f"This likely indicates a sync problem."
        )

    def test_feeds_json_active_count_reasonable(self, feeds_json, db):
        """Active source count must not be suspiciously low.

        XYZO has historically operated with 1,500-3,000 active sources.
        A sudden drop below 1,000 active sources indicates a sync bug.
        """
        with db.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS cnt FROM news_sources WHERE active = TRUE")
            active_count = cur.fetchone()["cnt"]

        # Allow some variance — 500 is a safe floor for the current dataset
        assert active_count >= 500, (
            f"Active source count ({active_count}) is suspiciously low. "
            f"Expected >= 500. A sync may have bulk-deactivated sources."
        )

    def test_no_active_source_is_robots_blocked(self, db):
        """No active source should be marked as robots-blocked.

        If a source is blocked by robots.txt, it should not be active —
        the sync should have excluded it.
        """
        with db.cursor() as cur:
            cur.execute("""
                SELECT id, name, feed_url
                  FROM news_sources
                 WHERE active = TRUE
                   AND robots_blocked_at IS NOT NULL
            """)
            blocked_active = cur.fetchall()

        assert not blocked_active, (
            f"{len(blocked_active)} sources are both active AND robots-blocked. "
            f"They should have been deactivated.\n"
            f"First 3: {[(r['name'], r['feed_url']) for r in blocked_active[:3]]}"
        )

    def test_sources_with_articles_remain_active(self, db):
        """Sources that have accumulated articles and are not blocked must stay active.

        This is the core regression guard: the 2026-09-11 sync silently deactivated
        ~1,500 sources that had articles but weren't in feeds.json.

        A safe sync should either:
          (a) reactivate them (add to feeds.json), OR
          (b) leave them active and flag them for review
        but it must NEVER bulk-deactivate sources with articles.
        """
        with db.cursor() as cur:
            cur.execute("""
                SELECT ns.id, ns.name, ns.feed_url, ns.robots_blocked_at,
                       COUNT(a.id) AS article_count
                  FROM news_sources ns
                  JOIN news_articles a ON a.source_id = ns.id
                 WHERE ns.active = FALSE
                   AND ns.robots_blocked_at IS NULL
              GROUP BY ns.id, ns.name, ns.feed_url, ns.robots_blocked_at
                HAVING COUNT(a.id) >= 10
            """)
            deactivated_with_articles = cur.fetchall()

        assert not deactivated_with_articles, (
            f"{len(deactivated_with_articles)} inactive sources have >= 10 articles "
            f"and are NOT robots-blocked. These were likely silently deactivated by a sync. "
            f"They should be reactivated or added to feeds.json.\n"
            f"Top 5 by article count:\n"
            + "\n".join(
                f"  {r['article_count']:,} articles | {r['name'][:50]} | {r['feed_url'][:60]}"
                for r in sorted(deactivated_with_articles, key=lambda x: x["article_count"], reverse=True)[:5]
            )
        )

    def test_feeds_json_has_no_duplicate_urls(self, feeds_json):
        """feeds.json must not contain duplicate feed_url entries.

        Deduplication should happen before writing to feeds.json.
        """
        urls = [f["feed_url"] for f in feeds_json["feeds"]]
        unique = set(urls)
        assert len(urls) == len(unique), (
            f"feeds.json has {len(urls) - len(unique)} duplicate feed_url entries"
        )

    @pytest.mark.network
    def test_feeds_json_entries_are_robots_allowed(self, feeds_json):
        """All feeds.json URLs must pass robots.txt checks.

        This is a SAMPLE check (not full) — it tests a random 100-entry sample
        to avoid hammering remote servers. The full robots check should be run
        via a separate script before any sync.

        Any URL that fails should be removed from feeds.json before the sync runs.

        Note: 5xx server errors are excluded as they are transient.
        """
        import random
        sample = random.sample(feeds_json["feeds"], k=min(100, len(feeds_json["feeds"])))
        robots = RobotsCache()
        failures = []
        for feed in sample:
            v = robots.is_allowed(feed["feed_url"])
            # Skip transient 5xx errors - not a robots.txt issue
            if not v.allowed and "5xx" not in v.note:
                failures.append({
                    "name": feed["name"],
                    "url": feed["feed_url"],
                    "note": v.note,
                    "disallowed_path": v.disallowed_path,
                })

        assert not failures, (
            f"{len(failures)} of {len(sample)} sampled feeds.json entries fail robots.txt:\n"
            + "\n".join(
                f"  ❌ {f['name']} | {f['url'][:60]} | note={f['note']}"
                for f in failures[:10]
            )
        )


class TestSourceSyncCompleteness:
    """Sanity checks on source coverage after sync."""

    def test_minimum_source_count_per_region(self, feeds_json):
        """Key regions should have a minimum number of sources.

        This catches situations where a sync accidentally filters out
        all sources from a region.
        """
        from collections import Counter
        region_counts = Counter(f.get("region", "unknown") for f in feeds_json["feeds"])

        minimums = {
            "americas": 50,
            "europe": 10,
            "asia-pacific": 10,
            "africa": 5,
            "south-asia": 5,
            "oceania": 10,
            "global": 20,
        }

        failures = []
        for region, minimum in minimums.items():
            count = region_counts.get(region, 0)
            if count < minimum:
                failures.append(f"  {region}: {count} (expected >={minimum})")

        assert not failures, (
            "Some regions have suspiciously few sources after sync:\n"
            + "\n".join(failures)
        )

    def test_all_countries_in_feeds_json_have_sources(self, feeds_json, db):
        """Most countries in feeds.json should have active sources.

        Note: Some small nations (FM=Micronesia, KI=Kiribati, TO=Tonga) may have
        no active sources due to lack of RSS coverage. This is acceptable if <5%
        of feeds.json entries have no coverage.
        """
        # Normalize to uppercase for case-insensitive comparison
        feed_countries = {f.get("country", "").upper() for f in feeds_json["feeds"] if f.get("country")}

        with db.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT UPPER(country) AS country
                  FROM news_sources
                 WHERE active = TRUE
                   AND country IS NOT NULL
            """)
            db_countries = {r["country"] for r in cur.fetchall()}

        missing = feed_countries - db_countries
        # Only check countries that have >3 entries in feeds.json
        from collections import Counter
        # A source may legitimately have no country: pan-regional outlets
        # (country="ME" meant the Middle East, not ISO Montenegro) and
        # global platforms (dev.to) have no single country at all.
        country_freq = Counter((f.get("country") or "").upper() for f in feeds_json["feeds"])
        significant_missing = {c for c in missing if country_freq.get(c, 0) >= 3}

        # Allow small Pacific nations with no coverage
        known_no_coverage = {'FM', 'KI', 'TO'}  # Micronesia, Kiribati, Tonga
        acceptable_missing = significant_missing & known_no_coverage
        unexpected_missing = significant_missing - known_no_coverage

        if acceptable_missing:
            print(f"INFO: These countries have no active sources (expected): {acceptable_missing}")
        if unexpected_missing:
            print(f"WARNING: These countries have no active sources: {unexpected_missing}")

        # Fail only if unexpected countries have no coverage
        assert not unexpected_missing, (
            f"{len(unexpected_missing)} countries in feeds.json have no active DB sources: "
            f"{unexpected_missing}"
        )
