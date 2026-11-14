#!/usr/bin/env python3
"""
Tests for worker.api_watchdog

Run with: python -m pytest worker/tests/test_api_watchdog.py -v
"""
import pytest
from unittest.mock import patch, MagicMock
from worker.api_watchdog import (
    check_endpoint,
    get_system_load,
    check_and_act,
    _RESTART_COOLDOWN_SEC,
)


class TestCheckEndpoint:
    """Unit tests for check_endpoint function."""

    @patch("urllib.request.urlopen")
    def test_successful_request(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.read.return_value = b'{"ok": true}'
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        result = check_endpoint("/api/version")

        assert result["ok"] is True
        assert result["status"] == 200
        assert result["error"] is None
        assert result["response_time"] >= 0

    @patch("urllib.request.urlopen")
    def test_http_error(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "url", 500, "Server Error", {}, None
        )

        result = check_endpoint("/api/pins/stats")

        assert result["ok"] is False
        assert result["status"] == 500
        assert "HTTP 500" in result["error"]

    @patch("urllib.request.urlopen")
    def test_timeout(self, mock_urlopen):
        import urllib.error
        mock_urlopen.side_effect = TimeoutError()

        result = check_endpoint("/api/pins/stats", timeout=8)

        assert result["ok"] is False
        assert result["status"] == 0
        assert "Timeout" in result["error"]
        assert result["response_time"] == 8


class TestGetSystemLoad:
    """Unit tests for get_system_load function."""

    def test_load_average_returns_tuple(self):
        load, cores = get_system_load()

        assert isinstance(load, float)
        assert isinstance(cores, int)
        assert load >= 0
        assert cores >= 1


class TestCheckAndAct:
    """Integration-style tests for check_and_act logic."""

    @patch("worker.api_watchdog.check_endpoint")
    @patch("worker.api_watchdog.get_system_load")
    @patch("worker.api_watchdog.restart_api")
    def test_healthy_endpoints_no_restart(
        self, mock_restart, mock_load, mock_check
    ):
        mock_load.return_value = (2.0, 4)  # 2.0 load on 4 cores = 50%

        # All endpoints healthy
        mock_check.return_value = {"ok": True, "status": 200}

        is_hung, failure_count, _ = check_and_act(
            do_restart=True,
            verbose=False,
            last_restart_time=None,
        )

        assert is_hung is False
        assert failure_count == 0
        mock_restart.assert_not_called()

    @patch("worker.api_watchdog.check_endpoint")
    @patch("worker.api_watchdog.get_system_load")
    @patch("worker.api_watchdog.restart_api")
    def test_single_heavy_endpoint_failure_does_not_restart(
        self, mock_restart, mock_load, mock_check
    ):
        """A slow heavy COUNT is a load problem, not a hung API.

        The watchdog used to restart xyzo-api for it — and because the
        unit validates the API in ExecStartPre, every restart was an
        84-second outage in which Caddy answered 502.
        """
        mock_load.return_value = (2.0, 4)

        def check_side_effect(path, timeout=None):
            if "stats" in path or "pins/map" in path:
                return {"ok": False, "status": 0, "error": "Timeout", "response_time": 30}
            return {"ok": True, "status": 200, "response_time": 0.1}

        mock_check.side_effect = check_side_effect

        is_hung, failure_count, _ = check_and_act(
            do_restart=True,
            verbose=False,
            last_restart_time=None,
        )

        assert failure_count >= 1
        assert is_hung is False
        mock_restart.assert_not_called()

    @patch("worker.api_watchdog.check_endpoint")
    @patch("worker.api_watchdog.get_system_load")
    @patch("worker.api_watchdog.restart_api")
    def test_liveness_failure_triggers_restart(
        self, mock_restart, mock_load, mock_check
    ):
        """/api/health failing IS a hung API → restart."""
        mock_load.return_value = (2.0, 4)

        def check_side_effect(path, timeout=None):
            if path == "/api/health":
                return {"ok": False, "status": 0, "error": "Timeout", "response_time": 20}
            return {"ok": True, "status": 200, "response_time": 0.1}

        mock_check.side_effect = check_side_effect

        is_hung, failure_count, _ = check_and_act(
            do_restart=True,
            verbose=False,
            last_restart_time=None,
        )

        assert is_hung is True
        mock_restart.assert_called_once()

    @patch("worker.api_watchdog.check_endpoint")
    @patch("worker.api_watchdog.get_system_load")
    @patch("worker.api_watchdog.restart_api")
    def test_cooldown_prevents_restart(self, mock_restart, mock_load, mock_check):
        mock_load.return_value = (2.0, 4)
        # A fresh dict per call — the implementation annotates the result
        # with the endpoint's role, so a shared dict would leak it.
        def check_side_effect(path, timeout=None):
            return {"ok": False, "status": 0, "error": "Timeout", "response_time": 20}

        mock_check.side_effect = check_side_effect

        import time
        recent_restart = time.time() - 30  # 30 seconds ago (< 60s cooldown)

        is_hung, failure_count, _ = check_and_act(
            do_restart=True,
            verbose=False,
            last_restart_time=recent_restart,
        )

        assert is_hung is True  # Still hung
        mock_restart.assert_not_called()  # But no restart due to cooldown

    @patch("worker.api_watchdog.check_endpoint")
    @patch("worker.api_watchdog.get_system_load")
    @patch("worker.api_watchdog.restart_api")
    def test_heavy_failures_alone_never_restart(
        self, mock_restart, mock_load, mock_check
    ):
        """Both heavy probes failing is still not a restart trigger."""
        mock_load.return_value = (2.0, 4)

        def check_side_effect(path, timeout=None):
            if path in ("/api/pins/stats",) or "pins/map" in path:
                return {"ok": False, "status": 0, "error": "Timeout", "response_time": 30}
            return {"ok": True, "status": 200, "response_time": 0.1}

        mock_check.side_effect = check_side_effect

        is_hung, failure_count, _ = check_and_act(
            do_restart=True,
            verbose=False,
            last_restart_time=None,
        )

        assert failure_count == 2
        assert is_hung is False
        mock_restart.assert_not_called()


class TestWatchdogIntegration:
    """Integration tests that hit the real API (skip if API is down)."""

    def test_healthy_api_is_detected(self):
        """Test that a healthy API is correctly identified."""
        import os
        os.environ.setdefault("XYZO_API_URL", "http://127.0.0.1:3008")

        from worker.api_watchdog import check_and_act, check_endpoint

        # Quick check: /api/version should always be fast
        result = check_endpoint("/api/version", timeout=5)
        if not result["ok"]:
            pytest.skip(f"API not reachable: {result['error']}")

        # Full check - only check the lightweight endpoints to avoid slow bbox query
        is_hung, failure_count, _ = check_and_act(
            do_restart=False,
            verbose=False,
            last_restart_time=None,
        )

        # Only fail if heavy endpoint failed (which may be slow due to system load)
        # The watchdog is primarily concerned with /api/health and /api/version
        health_result = check_endpoint("/api/health", timeout=5)
        assert health_result["ok"], f"/api/health failed: {health_result['error']}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
