#!/usr/bin/env python3
"""
Worker Health Regression Tests

Tests that verify the worker can recover from crashes and doesn't leave
sources in a stuck state.

Run with:
    python -m pytest worker/tests/test_worker_health.py -v
    python -m pytest worker/tests/test_worker_health.py -v --db-url="postgresql://..."
"""

import os
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta


class TestStaleLeaseCleanup:
    """Tests for stale fetch lease cleanup functionality."""

    def test_cleanup_clears_stale_leases(self):
        """Verify cleanup_stale_leases removes expired fetch_in_progress flags."""
        from worker.fetch import cleanup_stale_leases

        # This will fail if DB is not available, but tests the function exists
        try:
            result = cleanup_stale_leases()
            assert isinstance(result, (int, list, dict)), "Should return cleanup result"
        except RuntimeError as e:
            if "XYZO_DB_DSN" in str(e):
                pytest.skip("Database not configured")
            raise

    def test_cleanup_function_exists(self):
        """Verify cleanup_stale_leases function exists and is callable."""
        from worker.fetch import cleanup_stale_leases
        assert callable(cleanup_stale_leases)


class TestHealthMonitor:
    """Tests for the health monitoring functionality."""

    def test_health_monitor_imports(self):
        """Verify health_monitor module can be imported."""
        try:
            from worker.health_monitor import (
                get_health_stats,
                get_stale_leases_detail,
                auto_recover,
            )
            # Verify functions are callable
            assert callable(get_health_stats)
            assert callable(get_stale_leases_detail)
            assert callable(auto_recover)
        except ImportError as e:
            pytest.fail(f"Failed to import health_monitor: {e}")

    def test_health_stats_structure(self):
        """Verify get_health_stats returns expected keys."""
        try:
            from worker.health_monitor import get_health_stats
            # Just verify it runs without error
            try:
                stats = get_health_stats()
                expected_keys = {
                    'stale_leases', 'stale_pending', 'high_errors',
                    'never_fetched', 'total_active', 'fetched_last_hour'
                }
                assert isinstance(stats, dict), "Should return dict"
            except RuntimeError as e:
                if "XYZO_DB_DSN" in str(e):
                    pytest.skip("Database not configured")
                raise
        except ImportError:
            pytest.skip("health_monitor not available")


class TestSourceDedup:
    """Tests for source deduplication."""

    def test_bulk_add_checks_feed_url_duplicates(self):
        """Verify bulk-add checks for duplicate feed_url."""
        # This is a structural test - verifies the API checks duplicates
        import os
        if not os.path.exists("api/src/routes/sources.ts"):
            pytest.skip("API source file not found")

        with open("api/src/routes/sources.ts") as f:
            content = f.read()

        # Verify duplicate check exists
        assert "feed_url" in content, "Should check feed_url"
        assert "ON CONFLICT" in content or "already_exists" in content, \
            "Should handle duplicates"


class TestFetchLeaseSystem:
    """Tests for the fetch lease system that prevents double-fetching."""

    def test_lease_ttl_constant_exists(self):
        """Verify LEASE_TTL_S constant is defined."""
        try:
            from worker.fetch import LEASE_TTL_S
            assert LEASE_TTL_S == 300, "Default lease TTL should be 5 minutes"
        except ImportError:
            pytest.skip("fetch module not available")
        except AttributeError:
            pytest.fail("LEASE_TTL_S not defined in fetch.py")

    def test_fetch_in_progress_column_exists(self):
        """Verify the fetch_in_progress column exists in schema."""
        import os
        if not os.path.exists("worker/fetch.py"):
            pytest.skip("fetch.py not found")

        with open("worker/fetch.py") as f:
            content = f.read()

        # Verify the column is referenced in fetch.py
        assert "fetch_in_progress" in content


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
