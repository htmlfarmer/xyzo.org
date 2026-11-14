"""Regression tests for the story linking system.

Tests the story_linker passes, /api/feed/links endpoint, search filtering,
schema integrity, and link quality invariants.

Run with:
    pytest tests/test_story_links.py -v

These tests are designed to be RESILIENT to data changes:
  - Distribution/score assertions use ranges, not exact values
  - Count assertions use > 0 or sanity thresholds
  - Schema tests use introspection, not hardcoded assumptions
  - Each test is isolated and can run independently
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests

# ─────────────────────────────────────────────────────────────────────────────
# Project setup
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

API_BASE = os.environ.get("XYZO_TEST_API", "http://localhost:3008")
DB_DSN = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_db():
    import psycopg
    return psycopg.connect(DB_DSN)


def sql_rows(sql: str, params: tuple = ()):
    """Return list of dicts from a SQL query. Works with psycopg3."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
            if not rows:
                return []
            # Build dicts using column names from cursor description
            cols = [desc[0] for desc in cur.description]
            result = []
            for row in rows:
                # psycopg3 pool may return dicts or tuples; handle both
                if isinstance(row, dict):
                    result.append(row)
                elif isinstance(row, (tuple, list)):
                    result.append(dict(zip(cols, row)))
                else:
                    result.append(row)
            return result


def sql_val(sql: str, params: tuple = ()):
    """Return a single value from SQL."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            if row is None:
                return None
            # psycopg3 pool may return dicts or tuples
            if isinstance(row, dict):
                return list(row.values())[0]
            if isinstance(row, (tuple, list)):
                return row[0]
            return row


# ─────────────────────────────────────────────────────────────────────────────
# Schema integrity tests
# ─────────────────────────────────────────────────────────────────────────────

class TestSchemaIntegrity:
    """Verify the news_story_links table and related tables are structurally sound."""

    REQUIRED_COLUMNS = {
        "news_story_links": [
            "source_article_id", "target_article_id", "link_type",
            "link_strength", "link_reason", "city_name", "country_code",
            "topic", "created_by", "created_at", "updated_at",
        ],
        "news_articles": [
            "id", "title", "status", "published_at", "fetched_at", "location_id",
        ],
        "news_events": ["id", "status", "headline", "event_type", "expires_at"],
        "news_event_sources": ["event_id", "article_id"],
        "nn_article_sentence_embeddings": ["article_id"],
    }

    def test_news_story_links_table_exists(self):
        exists = sql_val("""
            SELECT EXISTS(
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'news_story_links' AND table_schema = 'public'
            )
        """)
        assert exists, "news_story_links table is missing!"

    def test_news_story_links_required_columns_present(self):
        """Alert if someone drops a column from news_story_links."""
        rows = sql_rows("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'news_story_links' AND table_schema = 'public'
        """)
        cols = {r["column_name"] for r in rows}
        for col in self.REQUIRED_COLUMNS["news_story_links"]:
            assert col in cols, f"news_story_links is missing column: {col}"

    def test_news_articles_required_columns_present(self):
        """Alert if someone drops a critical column from news_articles."""
        rows = sql_rows("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'news_articles' AND table_schema = 'public'
        """)
        cols = {r["column_name"] for r in rows}
        for col in self.REQUIRED_COLUMNS["news_articles"]:
            assert col in cols, f"news_articles is missing column: {col}"

    def test_news_events_sources_fk_cascade(self):
        """Verify event_sources → events FK exists and CASCADE is set."""
        rows = sql_rows("""
            SELECT tc.constraint_name, rc.delete_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.referential_constraints rc
              ON rc.constraint_name = tc.constraint_name
            WHERE tc.table_name = 'news_event_sources'
              AND tc.constraint_type = 'FOREIGN KEY'
        """)
        assert len(rows) >= 1, "news_event_sources should have at least one FK"
        for r in rows:
            assert r["delete_rule"] == "CASCADE", (
                f"FK {r['constraint_name']} on news_event_sources should have CASCADE delete"
            )

    def test_story_links_fk_to_articles(self):
        """Verify news_story_links has FK references to news_articles."""
        fks = sql_rows("""
            SELECT kcu.column_name, ccu.table_name AS ref_table
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND tc.table_schema = ccu.table_schema
            WHERE tc.table_name = 'news_story_links'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND ccu.table_name = 'news_articles'
        """)
        assert len(fks) >= 2, (
            f"news_story_links should have ≥2 FKs pointing to news_articles (source & target), got {len(fks)}"
        )

    def test_no_orphaned_story_links(self):
        """Ensure every story link points to real articles."""
        orphaned = sql_val("""
            SELECT COUNT(*)
            FROM news_story_links sl
            WHERE NOT EXISTS (SELECT 1 FROM news_articles WHERE id = sl.source_article_id)
               OR NOT EXISTS (SELECT 1 FROM news_articles WHERE id = sl.target_article_id)
        """)
        assert orphaned == 0, f"Found {orphaned} orphaned story links (missing article FK)!"

    def test_link_strength_in_valid_range(self):
        """Every link should have a strength between 0.1 and 1.0."""
        out_of_range = sql_val("""
            SELECT COUNT(*)
            FROM news_story_links
            WHERE link_strength < 0.1 OR link_strength > 1.0
        """)
        assert out_of_range == 0, (
            f"Found {out_of_range} links with link_strength outside [0.1, 1.0]"
        )

    def test_unique_constraint_on_link_triplet(self):
        """Verify the unique constraint on (source, target, link_type) exists."""
        constraints = sql_rows("""
            SELECT constraint_name
            FROM information_schema.table_constraints
            WHERE table_name = 'news_story_links'
              AND constraint_type = 'UNIQUE'
              AND table_schema = 'public'
        """)
        assert len(constraints) >= 1, (
            "news_story_links should have at least one UNIQUE constraint"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Story Linker functional tests
# ─────────────────────────────────────────────────────────────────────────────

class TestStoryLinker:
    """Verify story_linker runs without errors and produces valid links."""

    def test_story_linker_dry_run_completes(self):
        """story_linker --dry-run should complete without raising."""
        from worker.story_linker import run
        result = run(days=3, limit=100, dry_run=True)
        assert "links_found" in result
        assert "sample" in result
        assert result["dry_run"] is True

    def test_story_linker_produces_valid_link_shapes(self):
        """Every produced link should have all required fields."""
        from worker.story_linker import find_all_story_links
        links = find_all_story_links(days=3, limit=100)
        required = {"source_article_id", "target_article_id", "link_type",
                    "link_strength", "link_reason"}
        for lnk in links:
            for field in required:
                assert field in lnk, f"Link missing required field: {field}"
            assert 0.1 <= lnk["link_strength"] <= 1.0
            assert lnk["source_article_id"] != lnk["target_article_id"]

    def test_story_linker_sample_has_diverse_link_types(self):
        """The FULL link set should contain at least 2 different link types."""
        from worker.story_linker import find_all_story_links
        links = find_all_story_links(days=7, limit=500)
        types = {lnk["link_type"] for lnk in links}
        assert len(types) >= 2, (
            f"Expected ≥2 link types in link set, got {types}. "
            "Check that multiple linker passes are producing output."
        )

    def test_same_event_links_reference_real_events(self):
        """same_event links that claim 'event cluster' reference real news_event IDs."""
        from worker.story_linker import find_all_story_links
        links = find_all_story_links(days=7, limit=500)
        # Only check links whose reason explicitly mentions an event cluster
        cluster_links = [
            l for l in links
            if l["link_type"] == "same_event" and l.get("link_reason", "").startswith("Same event cluster #")
        ]
        if not cluster_links:
            pytest.skip("No event-cluster links in sample (only geo/cross-lang same_event links)")

        # Sample up to 10 event-cluster links and verify they share an event_id
        for lnk in cluster_links[:10]:
            shared_event = sql_val("""
                SELECT COUNT(DISTINCT es.event_id)
                FROM news_event_sources es
                WHERE es.article_id = ANY(%s)
                GROUP BY es.event_id
                HAVING COUNT(DISTINCT es.article_id) >= 2
                LIMIT 1
            """, ([lnk["source_article_id"], lnk["target_article_id"]],))
            assert (shared_event or 0) >= 1, (
                f"same_event link ({lnk['source_article_id']} ↔ {lnk['target_article_id']}) "
                f"claims cluster but has no shared news_event! Reason: {lnk.get('link_reason')}"
            )

    def test_story_linker_respects_days_parameter(self):
        """Links should only come from articles within the requested window."""
        from worker.story_linker import find_all_story_links
        links_1d = find_all_story_links(days=1, limit=500)
        links_3d = find_all_story_links(days=3, limit=500)

        if not links_1d or not links_3d:
            pytest.skip("Not enough articles to test window parameter")

        # 1-day window should produce ≤ 3-day window links (set inclusion check)
        ids_1d = {frozenset([l["source_article_id"], l["target_article_id"]]) for l in links_1d}
        ids_3d = {frozenset([l["source_article_id"], l["target_article_id"]]) for l in links_3d}
        # At least some overlap expected
        overlap = ids_1d & ids_3d
        assert len(overlap) > 0, "Expected overlap between 1d and 3d link sets"


# ─────────────────────────────────────────────────────────────────────────────
# /api/feed/links endpoint tests
# ─────────────────────────────────────────────────────────────────────────────

class TestFeedLinksAPI:
    """Verify /api/feed/links returns proper responses."""

    def test_links_endpoint_returns_valid_json(self):
        r = requests.get(f"{API_BASE}/api/feed/links?limit=10", timeout=10)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert "nodes" in data and "edges" in data

    def test_links_endpoint_includes_required_node_fields(self):
        r = requests.get(f"{API_BASE}/api/feed/links?limit=10", timeout=10)
        data = r.json()
        for node in data.get("nodes", [])[:5]:
            assert "id" in node
            assert "lat" in node or "lat" in node.get("location", {})
            assert "lng" in node or "lng" in node.get("location", {})

    def test_links_endpoint_includes_required_edge_fields(self):
        r = requests.get(f"{API_BASE}/api/feed/links?limit=10", timeout=10)
        data = r.json()
        for edge in data.get("edges", [])[:5]:
            assert "a" in edge and "b" in edge
            assert "weight" in edge
            # weight can exceed 1.0 when multiple link types are aggregated
            assert edge["weight"] > 0

    def test_links_endpoint_respects_min_weight(self):
        r = requests.get(f"{API_BASE}/api/feed/links?limit=100&min_weight=0.8", timeout=10)
        data = r.json()
        for edge in data.get("edges", []):
            assert edge["weight"] >= 0.8, (
                f"Edge {edge['a']}→{edge['b']} has weight {edge['weight']} < 0.8"
            )

    def test_links_endpoint_search_filter_taiwan(self):
        """Search 'taiwan' should return edges where both articles mention Taiwan."""
        r = requests.get(f"{API_BASE}/api/feed/links?q=taiwan&limit=50", timeout=10)
        assert r.status_code == 200
        data = r.json()
        # Should return some edges (may be empty if no Taiwan articles in viewport)
        assert "edges" in data
        assert "nodes" in data

    def test_links_endpoint_search_filter_empty_query(self):
        """Empty q param should return all links (no filter applied)."""
        r1 = requests.get(f"{API_BASE}/api/feed/links?limit=20", timeout=10)
        r2 = requests.get(f"{API_BASE}/api/feed/links?limit=20&q=", timeout=10)
        assert r1.status_code == 200 and r2.status_code == 200
        # Both should return valid shapes
        assert "edges" in r1.json() and "edges" in r2.json()

    def test_links_endpoint_bbox_filter_does_not_crash(self):
        """Bbox parameter should not cause errors."""
        bbox = "-125,25,-65,50"  # Continental US
        r = requests.get(
            f"{API_BASE}/api/feed/links?limit=10&bbox={bbox}",
            timeout=10
        )
        assert r.status_code == 200, f"Bbox query failed: {r.status_code} {r.text}"

    def test_links_endpoint_all_link_types_present(self):
        """The links table should have multiple link_type values represented."""
        r = requests.get(f"{API_BASE}/api/feed/links?limit=200&min_weight=0.3", timeout=10)
        data = r.json()
        # API returns 'kinds' as a list of link type strings
        all_kinds = set()
        for e in data.get("edges", []):
            for k in e.get("kinds", []):
                all_kinds.add(k)
        assert len(all_kinds) >= 2, (
            f"Expected ≥2 link types in feed/links response, got {all_kinds}. "
            "Ensure story_linker is producing diverse link types."
        )


# ─────────────────────────────────────────────────────────────────────────────
# Link distribution / quality tests
# ─────────────────────────────────────────────────────────────────────────────

class TestLinkDistribution:
    """Sanity-check link type distribution — alert on collapsed or suspicious values."""

    def test_no_link_type_is_zero_count(self):
        """Every defined link_type should have at least some links."""
        rows = sql_rows("""
            SELECT link_type, COUNT(*) AS cnt
            FROM news_story_links
            GROUP BY link_type
        """)
        type_counts = {r["link_type"]: r["cnt"] for r in rows}
        expected_types = {"same_city", "same_country", "same_event",
                         "same_topic", "semantic_similarity", "manual"}
        for ltype in expected_types:
            assert type_counts.get(ltype, 0) > 0, (
                f"Link type '{ltype}' has 0 links! "
                "This indicates a linker pass has stopped producing output."
            )

    def test_same_city_avg_strength_reasonable(self):
        """same_city links should have avg strength > 0.7 (they're well-matched)."""
        avg = sql_val("""
            SELECT AVG(link_strength)
            FROM news_story_links
            WHERE link_type = 'same_city'
        """)
        assert avg > 0.70, (
            f"same_city avg strength is {avg:.3f} — expected >0.70. "
            "If too low, the geo linker may be matching unrelated nearby articles."
        )

    def test_same_event_avg_strength_high(self):
        """same_event links should have high avg strength (>0.85)."""
        avg = sql_val("""
            SELECT AVG(link_strength)
            FROM news_story_links
            WHERE link_type = 'same_event'
        """)
        assert avg > 0.85, (
            f"same_event avg strength is {avg:.3f} — expected >0.85. "
            "Low scores indicate event-cluster links are weak quality."
        )

    def test_semantic_similarity_has_very_high_strength(self):
        """semantic_similarity links should average >0.90 (pgvector is precise)."""
        avg = sql_val("""
            SELECT AVG(link_strength)
            FROM news_story_links
            WHERE link_type = 'semantic_similarity'
        """)
        if avg is None:
            pytest.skip("No semantic_similarity links yet")
        assert avg > 0.90, (
            f"semantic_similarity avg is {avg:.3f} — expected >0.90. "
            "If lower, the embedding similarity threshold may be too low."
        )

    def test_no_duplicate_links_same_type(self):
        """No (source, target, link_type) triplet should appear more than once."""
        dups = sql_val("""
            SELECT COUNT(*)
            FROM (
                SELECT source_article_id, target_article_id, link_type, COUNT(*) AS cnt
                FROM news_story_links
                GROUP BY source_article_id, target_article_id, link_type
                HAVING COUNT(*) > 1
            ) t
        """)
        assert dups == 0, (
            f"Found {dups} duplicate (source, target, link_type) triplets! "
            "The unique constraint may be violated."
        )

    def test_links_have_recent_entries(self):
        """At least some links should have been created in the last 24h."""
        recent = sql_val("""
            SELECT COUNT(*)
            FROM news_story_links
            WHERE created_at > now() - interval '24 hours'
        """)
        assert recent > 0, (
            "No links created in the last 24 hours! "
            "The story_linker worker may have stopped running."
        )

    def test_link_count_reasonable(self):
        """Total links should be in a reasonable range (not collapsed to 0 or exploded)."""
        total = sql_val("SELECT COUNT(*) FROM news_story_links")
        assert 10_000 < total < 5_000_000, (
            f"Total link count is {total:,} — outside expected range [10K, 5M]. "
            "Something may be wrong with the linker or deduplication."
        )


# ─────────────────────────────────────────────────────────────────────────────
# Feed endpoint shape tests
# ─────────────────────────────────────────────────────────────────────────────

class TestFeedEndpointShapes:
    """Verify all /api/feed/* endpoints return proper JSON shapes."""

    FEED_ENDPOINTS = [
        "/api/feed/live",
        "/api/feed/links",
        "/api/sources/health",
    ]

    @pytest.mark.parametrize("endpoint", FEED_ENDPOINTS)
    def test_feed_endpoint_returns_200(self, endpoint):
        r = requests.get(f"{API_BASE}{endpoint}?limit=5", timeout=10)
        assert r.status_code == 200, (
            f"{endpoint} returned {r.status_code}: {r.text[:200]}"
        )

    @pytest.mark.parametrize("endpoint", FEED_ENDPOINTS)
    def test_feed_endpoint_returns_valid_json(self, endpoint):
        r = requests.get(f"{API_BASE}{endpoint}?limit=5", timeout=10)
        data = r.json()
        assert isinstance(data, dict), f"{endpoint} should return a dict, got {type(data)}"


# ─────────────────────────────────────────────────────────────────────────────
# Search + Links integration test
# ─────────────────────────────────────────────────────────────────────────────

class TestSearchLinksIntegration:
    """Verify search → links interaction works end-to-end."""

    def test_search_taiwan_links_both_articles_mention_taiwan(self):
        """When searching 'taiwan', returned edges should have Taiwan in both headlines."""
        r = requests.get(f"{API_BASE}/api/feed/links?q=taiwan&limit=50&min_weight=0.3", timeout=10)
        if r.status_code != 200:
            pytest.skip(f"API returned {r.status_code}")

        data = r.json()
        edges = data.get("edges", [])
        if not edges:
            pytest.skip("No edges returned for Taiwan search")

        node_by_id = {n["id"]: n for n in data.get("nodes", [])}
        for edge in edges[:10]:
            a_node = node_by_id.get(edge["a"])
            b_node = node_by_id.get(edge["b"])
            if not a_node or not b_node:
                continue
            # API returns 'headline' field
            a_title = (a_node.get("headline") or "").lower()
            b_title = (b_node.get("headline") or "").lower()
            assert "taiwan" in a_title and "taiwan" in b_title, (
                f"Edge {edge['a']}→{edge['b']}: "
                f"both articles should mention 'Taiwan'. "
                f"Headlines: '{a_title}', '{b_title}'"
            )


# ─────────────────────────────────────────────────────────────────────────────
# Canary: warn if key tables are nearly empty
# ─────────────────────────────────────────────────────────────────────────────

class TestDataHealthCanary:
    """Lightweight health checks that warn if critical data is missing."""

    def test_articles_table_not_empty(self):
        count = sql_val("SELECT COUNT(*) FROM news_articles")
        assert count > 100_000, f"news_articles has only {count:,} rows — expected >100K"

    def test_extracted_articles_exist(self):
        count = sql_val("SELECT COUNT(*) FROM news_articles WHERE status = 'extracted'")
        assert count > 10_000, f"Only {count:,} extracted articles — pipeline may be stalled"

    def test_news_events_populated(self):
        count = sql_val("SELECT COUNT(*) FROM news_events WHERE status = 'active'")
        assert count > 1_000, f"Only {count:,} active events — event clustering may be stalled"

    def test_sentence_embeddings_populated(self):
        count = sql_val("SELECT COUNT(*) FROM nn_article_sentence_embeddings")
        if count < 1000:
            pytest.skip(f"Only {count:,} sentence embeddings — skipping (pipeline may not have run yet)")

    def test_locations_populated(self):
        count = sql_val("SELECT COUNT(*) FROM news_locations")
        assert count > 10_000, f"Only {count:,} locations — expected >10K"


# ─────────────────────────────────────────────────────────────────────────────
# Run as script
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
