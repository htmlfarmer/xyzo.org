"""
Health monitoring tests for Xyzo API.
These tests verify the critical health and status endpoints and
can be used for uptime monitoring / alerting.
"""
import subprocess
import time

import pytest

pytestmark = pytest.mark.live  # requires localhost:3008 / live xyzo.org (TEST_PLAN 6.2)


class TestAPIHealth:
    """Test API health endpoint responds correctly."""

    API_URL = "http://localhost:3008"

    def test_health_endpoint_responds(self):
        """Health endpoint should return 200 within reasonable time."""
        result = subprocess.run(
            ["curl", "-s", "-w", "%{http_code}", "-o", "/dev/null",
             f"{self.API_URL}/api/health"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.stdout.strip() == "200", (
            f"Health endpoint returned {result.stdout}, expected 200"
        )

    def test_health_endpoint_fast_enough(self):
        """Health endpoint should respond within 2 seconds."""
        import time
        start = time.time()
        result = subprocess.run(
            ["curl", "-s", f"{self.API_URL}/api/health"],
            capture_output=True, text=True, timeout=5,
        )
        elapsed = time.time() - start

        assert elapsed < 2.0, f"Health endpoint took {elapsed:.2f}s, expected < 2s"
        assert result.stdout, "Health endpoint returned empty response"

    def test_pins_map_responds(self):
        """Pins map endpoint should return valid JSON."""
        import json
        result = subprocess.run(
            ["curl", "-s", f"{self.API_URL}/api/pins/map?limit=5"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        assert "items" in data or "count" in data, (
            f"Unexpected response shape: {list(data.keys())}"
        )

    def test_pins_stats_responds(self):
        """Pins stats endpoint should return counts."""
        import json
        result = subprocess.run(
            ["curl", "-s", f"{self.API_URL}/api/pins/stats"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        assert "counts" in data, f"Missing counts in response: {list(data.keys())}"
        assert "all" in data["counts"], (
            f"Missing 'all' count: {data['counts'].keys()}"
        )


class TestDatabaseConnection:
    """Test database connectivity."""

    def test_database_has_pins(self):
        """Verify database has articles with valid locations."""
        import psycopg

        conn = psycopg.connect(
            "postgresql://xyzo_app@localhost:5432/xyzo", connect_timeout=5
        )
        cur = conn.cursor()

        cur.execute("""
            SELECT COUNT(*) FROM news_articles
            WHERE status = 'extracted'
            AND (location_id IS NOT NULL OR extracted_lat IS NOT NULL)
        """)
        count = cur.fetchone()[0]
        conn.close()

        assert count > 1000, (
            f"Only {count} articles with valid locations - "
            "pipeline may be stalled"
        )

    def test_database_has_recent_articles(self):
        """Verify articles were fetched recently."""
        import psycopg
        from datetime import datetime, timedelta

        conn = psycopg.connect(
            "postgresql://xyzo_app@localhost:5432/xyzo", connect_timeout=5
        )
        cur = conn.cursor()

        cur.execute("""
            SELECT COUNT(*) FROM news_articles
            WHERE fetched_at > now() - interval '1 hour'
        """)
        count = cur.fetchone()[0]
        conn.close()

        assert count > 0, (
            "No articles fetched in the last hour - "
            "fetcher may not be running"
        )


class TestWorkerPipeline:
    """Test worker pipeline components."""

    def test_extract_module_syntax(self):
        """extract.py should have valid syntax and callable functions."""
        import subprocess

        result = subprocess.run(
            ["python3", "-m", "py_compile", "worker/extract.py"],
            capture_output=True,
            text=True,
            cwd="/var/www/vhosts/xyzo.org",
        )
        assert result.returncode == 0, (
            f"extract.py has syntax errors: {result.stderr}"
        )

    def test_geocode_module_syntax(self):
        """geocode.py should have valid syntax."""
        import subprocess

        result = subprocess.run(
            ["python3", "-m", "py_compile", "worker/geocode.py"],
            capture_output=True,
            text=True,
            cwd="/var/www/vhosts/xyzo.org",
        )
        assert result.returncode == 0, (
            f"geocode.py has syntax errors: {result.stderr}"
        )

    def test_cluster_module_syntax(self):
        """cluster.py should have valid syntax."""
        import subprocess

        result = subprocess.run(
            ["python3", "-m", "py_compile", "worker/cluster.py"],
            capture_output=True,
            text=True,
            cwd="/var/www/vhosts/xyzo.org",
        )
        assert result.returncode == 0, (
            f"cluster.py has syntax errors: {result.stderr}"
        )

    def test_batch_update_function_exists(self):
        """Verify _batch_update_articles is defined and used correctly."""
        from worker.extract import _batch_update_articles
        assert callable(_batch_update_articles)


class TestMemoryPressure:
    """Test for memory pressure issues."""

    def test_api_memory_not_near_limit(self):
        """API memory should not be at 99% of limit."""
        import subprocess

        result = subprocess.run(
            ["systemctl", "show", "xyzo-api.service", "-p", "MemoryCurrent,MemoryHigh"],
            capture_output=True,
            text=True,
        )

        lines = result.stdout.strip().split("\n")
        memory_current = None
        memory_high = None

        for line in lines:
            if "=" in line:
                key, value = line.split("=", 1)
                if key == "MemoryCurrent":
                    memory_current = int(value)
                elif key == "MemoryHigh":
                    memory_high = int(value)

        if memory_current and memory_high and memory_high > 0:
            usage_pct = (memory_current / memory_high) * 100
            assert usage_pct < 95, (
                f"API memory at {usage_pct:.1f}% of limit "
                f"({memory_current / 1024 / 1024:.0f}M / {memory_high / 1024 / 1024:.0f}M) - "
                "should be below 95%"
            )


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
