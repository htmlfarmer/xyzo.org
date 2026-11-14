"""
Tests for news source addition workflow (AGENTS.md § Adding News Sources).

Validates:
  1. Candidate sources pass robots.txt checks before being added.
  2. feeds.json contains no duplicate URLs.
  3. Every active source in the DB has a corresponding entry in feeds.json.
  4. Every feeds.json entry is represented in the DB (exact match).
  5. Source schema: required fields (name, feed_url, country, region) are present.

Run with: pytest worker/tests/test_news_source_addition.py -v
"""

import json
import os
import pytest

# Ensure XYZO_DB_DSN is set for tests
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


@pytest.fixture
def robots():
    """Fresh RobotsCache instance."""
    return RobotsCache()


# ---------------------------------------------------------------------------
# Test: feeds.json structure
# ---------------------------------------------------------------------------

class TestFeedsJsonStructure:
    """feeds.json is well-formed and contains no obvious issues."""

    def test_file_parses(self, feeds_json):
        """feeds.json is valid JSON with a 'feeds' key."""
        assert isinstance(feeds_json, dict), "feeds.json must be a JSON object"
        assert "feeds" in feeds_json, "feeds.json must have a 'feeds' key"
        assert isinstance(feeds_json["feeds"], list), "'feeds' must be a list"

    def test_no_duplicate_feed_urls(self, feeds_json):
        """No two entries in feeds.json share the same feed_url."""
        urls = [f["feed_url"] for f in feeds_json["feeds"]]
        unique_urls = set(urls)
        assert len(urls) == len(unique_urls), (
            f"feeds.json has duplicate feed_urls: "
            f"{len(urls) - len(unique_urls)} duplicates"
        )

    def test_required_fields_present(self, feeds_json):
        """Every feed entry has name, feed_url, country, and region."""
        required = {"name", "feed_url", "country", "region"}
        errors = []
        for i, feed in enumerate(feeds_json["feeds"]):
            missing = required - set(feed.keys())
            if missing:
                errors.append(f"entry {i} ({feed.get('name','?')}) missing: {missing}")
        assert not errors, "\n".join(errors)

    def test_all_feeds_have_valid_source_type(self, feeds_json):
        """Every feed has a source_type in the allowed set (or defaults to rss)."""
        valid_types = {"rss", "atom", "geojson", "json", "web"}
        errors = []
        for feed in feeds_json["feeds"]:
            st = feed.get("source_type", "rss")
            if st not in valid_types:
                errors.append(
                    f"{feed['name']}: invalid source_type '{st}'"
                )
        assert not errors, "\n".join(errors)

    def test_no_empty_feed_urls(self, feeds_json):
        """No feed entry has an empty feed_url."""
        empty = [f["name"] for f in feeds_json["feeds"] if not f.get("feed_url")]
        assert not empty, f"Feeds with empty feed_url: {empty}"


# ---------------------------------------------------------------------------
# Test: robots.txt compliance
# ---------------------------------------------------------------------------

@pytest.mark.network
class TestRobotsTxtCompliance:
    """Candidate news sources are checked against robots.txt before addition.

    Hits live BBC/Guardian/AP robots.txt over the network — skip in CI
    with: pytest -m 'not network' (see TEST_PLAN_2026-09-26 §6.2).
    """

    # These URLs should ALWAYS be allowed (verified at addition time)
    KNOWN_ALLOWED_URLS = [
        "https://www.reutersagency.com/feed/",
        "https://feeds.apnews.com/apnews",
        "https://www.theguardian.com/world/rss",
        "https://feeds.bbci.co.uk/news/world/rss.xml",
    ]

    # These URL patterns are KNOWN to be blocked and should NOT be added
    KNOWN_BLOCKED_PATTERNS = [
        "theregister.com/feed",   # blocks /feed/
        "newscientist.com/feed",  # blocks /feed/home/
    ]

    def test_robots_cache_is_callable(self, robots):
        """RobotsCache.is_allowed() returns a RobotsVerdict without raising."""
        v = robots.is_allowed("https://example.com/feed/")
        assert hasattr(v, "allowed"), "is_allowed must return a verdict object"
        assert hasattr(v, "note"),   "verdict must have a 'note' field"
        assert hasattr(v, "crawl_delay_s"), "verdict must have crawl_delay_s"

    def test_known_allowed_sources_pass(self, robots):
        """Sources we trust (BBC, Guardian, AP) are allowed by robots.txt."""
        for url in self.KNOWN_ALLOWED_URLS:
            v = robots.is_allowed(url)
            assert v.allowed, (
                f"{url} should be allowed but got: "
                f"allowed={v.allowed}, note={v.note}, "
                f"blocked_path={v.disallowed_path}"
            )

    def test_known_blocked_patterns_are_rejected(self, robots):
        """Sources known to block /feed/ are properly rejected."""
        for pattern in self.KNOWN_BLOCKED_PATTERNS:
            # Try a representative URL for this domain
            if "theregister" in pattern:
                url = "https://www.theregister.com/feed/"
            elif "newscientist" in pattern:
                url = "https://www.newscientist.com/feed/home/"
            else:
                continue
            v = robots.is_allowed(url)
            assert not v.allowed, (
                f"{url} should be blocked but got allowed=True"
            )
            assert v.disallowed_path, (
                f"{url} should report which path was blocked"
            )

    def test_sample_of_feeds_json_passes_robots(self, robots, feeds_json):
        """A random sample of feeds.json entries are allowed by robots.txt.

        We test a sample (not all) to avoid hammering remote servers during
        test runs.  The full validation should run via check_feeds.py.
        """
        import random
        sample = random.sample(
            feeds_json["feeds"],
            k=min(30, len(feeds_json["feeds"]))
        )
        blocked = []
        for feed in sample:
            v = robots.is_allowed(feed["feed_url"])
            if not v.allowed:
                blocked.append(
                    f"{feed['name']}: {feed['feed_url']} — "
                    f"note={v.note}, path={v.disallowed_path}"
                )
        assert not blocked, (
            f"{len(blocked)} of {len(sample)} sampled feeds are blocked:\n"
            + "\n".join(blocked)
        )


# ---------------------------------------------------------------------------
# Test: DB / feeds.json exact match
# ---------------------------------------------------------------------------

class TestDatabaseSync:
    """The news_sources DB table exactly mirrors feeds.json."""

    def test_all_feeds_json_sources_in_db(self, feeds_json, db):
        """Every unique URL in feeds.json exists in the DB."""
        feed_urls = [f["feed_url"] for f in feeds_json["feeds"]]
        unique_urls = list(set(feed_urls))

        with db.cursor() as cur:
            cur.execute(
                """
                SELECT feed_url
                  FROM news_sources
                 WHERE feed_url = ANY(%s)
                """,
                [unique_urls],
            )
            rows = cur.fetchall()
            db_urls = {r["feed_url"] for r in rows}

        missing = set(unique_urls) - db_urls
        assert not missing, (
            f"{len(missing)} feeds.json URLs not found in DB: "
            f"{list(missing)[:5]}"
        )

    def test_all_db_active_sources_in_feeds_json(self, feeds_json, db):
        """Every active source in the DB corresponds to a feeds.json entry."""
        feed_urls = {f["feed_url"].lower() for f in feeds_json["feeds"]}

        with db.cursor() as cur:
            cur.execute("""
                SELECT feed_url
                  FROM news_sources
                 WHERE active = true
            """)
            rows = cur.fetchall()
            db_active_urls = {r["feed_url"].lower() for r in rows}

        orphaned = db_active_urls - feed_urls
        assert not orphaned, (
            f"{len(orphaned)} active DB sources not in feeds.json "
            f"(first 5): {list(orphaned)[:5]}"
        )

    def test_db_active_count_matches_feeds_json(self, feeds_json, db):
        """DB active source count equals unique URL count in feeds.json.

        Note: feeds.json may list the same URL multiple times under different
        names/regions.  The DB correctly deduplicates by URL, so we compare
        against the unique-URL count.
        """
        unique_urls = set(f["feed_url"] for f in feeds_json["feeds"])

        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) AS cnt
                  FROM news_sources
                 WHERE active = true
                   AND feed_url = ANY(%s)
            """, [list(unique_urls)])
            row = cur.fetchone()
            db_active_count = row["cnt"]

        assert db_active_count == len(unique_urls), (
            f"DB has {db_active_count} active sources matching feeds.json, "
            f"but feeds.json has {len(unique_urls)} unique URLs"
        )

    def test_no_inactive_feeds_json_sources(self, feeds_json, db):
        """All feeds.json entries are marked active in the DB."""
        feed_urls = [f["feed_url"] for f in feeds_json["feeds"]]

        with db.cursor() as cur:
            cur.execute("""
                SELECT feed_url, name, active
                  FROM news_sources
                 WHERE feed_url = ANY(%s)
                   AND active = false
            """, [feed_urls])
            inactive = cur.fetchall()

        assert not inactive, (
            f"{len(inactive)} feeds.json sources are inactive in DB:\n"
            + "\n".join(f"  {r['name']}: {r['feed_url']}" for r in inactive)
        )

    def test_no_duplicate_active_urls_in_db(self, db):
        """The DB has at most one active row per feed_url."""
        with db.cursor() as cur:
            cur.execute("""
                SELECT feed_url, COUNT(*) AS cnt
                  FROM news_sources
                 WHERE active = true
                 GROUP BY feed_url
                HAVING COUNT(*) > 1
            """)
            dupes = cur.fetchall()

        assert not dupes, (
            f"DB has duplicate active URLs: "
            f"{[(d['feed_url'], d['cnt']) for d in dupes]}"
        )


# ---------------------------------------------------------------------------
# Test: source schema completeness
# ---------------------------------------------------------------------------

class TestSourceSchema:
    """All active sources in the DB have required metadata fields."""

    def test_active_sources_have_country(self, db):
        """Every active source has a non-null country — unless it is
        explicitly a country-less regional/global outlet.

        A source that publishes from a whole region (the 139 MENA
        papers) or from everywhere (dev.to) has no single country, and
        guessing one is what put 41,106 stories on Podgorica, Montenegro
        and 12,368 on Bamako, Mali. Those sources carry their region and
        are placed from their own text instead.

        The marker is either the region vocabulary ('mena' / 'global')
        or the coverage role in `locality` ('regional' /
        'international') — the column that exists for exactly this. A
        country-less source with a fine-grained region ('africa',
        'south-america') is a regional desk, not a mistake.
        """
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) AS cnt
                  FROM news_sources
                 WHERE active = true
                   AND (country IS NULL OR country = '')
                   AND LOWER(COALESCE(region, '')) NOT IN ('mena', 'global')
                   AND LOWER(COALESCE(locality, '')) NOT IN ('regional', 'international')
            """)
            row = cur.fetchone()
            missing = row["cnt"]

        assert missing == 0, (
            f"{missing} active sources have no country and are not marked "
            "as a regional/global outlet"
        )

    def test_active_sources_have_region(self, db):
        """Every active source has a non-null region."""
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) AS cnt
                  FROM news_sources
                 WHERE active = true
                   AND (region IS NULL OR region = '')
            """)
            row = cur.fetchone()
            missing = row["cnt"]

        assert missing == 0, (
            f"{missing} active sources have no region"
        )

    def test_source_type_is_valid(self, db):
        """All active sources have a source_type in the allowed set."""
        valid = {"rss", "atom", "geojson", "json", "web"}
        valid_list = ",".join(f"'{v}'" for v in valid)
        with db.cursor() as cur:
            cur.execute(f"""
                SELECT id, name, source_type
                  FROM news_sources
                 WHERE active = true
                   AND source_type IS NOT NULL
                   AND source_type NOT IN ({valid_list})
            """)
            invalid = cur.fetchall()

        assert not invalid, (
            f"{len(invalid)} sources have invalid source_type: "
            f"{[(r['name'], r['source_type']) for r in invalid]}"
        )


# ---------------------------------------------------------------------------
# Test: new source addition workflow (integration)
# ---------------------------------------------------------------------------

class TestSourceAdditionWorkflow:
    """Full workflow for adding new sources is correct and repeatable."""

    def test_upsert_does_not_duplicate(self, feeds_json, db):
        """Running the upsert multiple times does not create duplicate rows.

        This simulates what happens when seed_sources() is called after
        feeds.json is updated — it should update, not insert duplicate.
        """
        # Pick the first feed as a test subject
        test_feed = feeds_json["feeds"][0]
        url = test_feed["feed_url"]
        name = test_feed["name"]
        country = test_feed.get("country", "US")
        language = test_feed.get("language", "en")
        region = test_feed.get("region", "global")
        source_type = test_feed.get("source_type", "rss")

        # Verify it exists
        with db.cursor() as cur:
            cur.execute(
                "SELECT id, name, active FROM news_sources WHERE feed_url = %s",
                [url],
            )
            before = cur.fetchone()

        assert before is not None, f"Test feed {name} not in DB"

        # Run upsert (simulate seed_sources)
        with db.cursor() as cur:
            cur.execute("""
                INSERT INTO news_sources
                    (name, feed_url, country, language, region, source_type)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (feed_url) DO UPDATE SET
                    name = EXCLUDED.name,
                    country = EXCLUDED.country,
                    language = EXCLUDED.language,
                    region = EXCLUDED.region
            """, [name, url, country, language, region, source_type])
            db.commit()

        # Count active rows for this URL
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) AS cnt,
                       BOOL_OR(active) AS is_active
                  FROM news_sources
                 WHERE feed_url = %s
            """, [url])
            row = cur.fetchone()

        assert row["cnt"] == 1, (
            f"Expected 1 row for {url}, got {row['cnt']} "
            f"(upsert created duplicates)"
        )
        assert row["is_active"] is True, (
            f"Source should remain active after upsert"
        )

    def test_deactivate_removes_from_active_count(self, feeds_json, db):
        """Deactivating a source removes it from the active count.

        This is the inverse of the normal sync operation.
        """
        # Pick a feed that is active
        active_feed = None
        for f in feeds_json["feeds"]:
            url = f["feed_url"]
            with db.cursor() as cur:
                cur.execute(
                    "SELECT active FROM news_sources WHERE feed_url = %s",
                    [url],
                )
                row = cur.fetchone()
            if row and row["active"]:
                active_feed = f
                break

        assert active_feed is not None, "No active feed found to test with"
        url = active_feed["feed_url"]

        # Deactivate
        with db.cursor() as cur:
            cur.execute("""
                UPDATE news_sources
                   SET active = false, updated_at = NOW()
                 WHERE feed_url = %s
            """, [url])
            db.commit()

        # Verify inactive
        with db.cursor() as cur:
            cur.execute(
                "SELECT active FROM news_sources WHERE feed_url = %s",
                [url],
            )
            row = cur.fetchone()

        assert row is not None, f"Source {url} disappeared from DB"
        assert row["active"] is False, (
            f"Source {url} should be inactive but is {row['active']}"
        )

        # Reactivate (cleanup)
        with db.cursor() as cur:
            cur.execute("""
                UPDATE news_sources
                   SET active = true, updated_at = NOW()
                 WHERE feed_url = %s
            """, [url])
            db.commit()
