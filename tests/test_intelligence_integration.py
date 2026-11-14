"""Integration test: first crawl triggers AI scan, second uses cache.

Mocks HTTP, AI, and DB to test the orchestration end-to-end.
"""
from unittest.mock import patch, MagicMock
import datetime as dt


class TestFirstCrawlTriggersScan:
    def test_no_record_schedules_scan(self):
        from worker.site_crawl import load_intelligence
        with patch("worker.site_crawl._fetch_intelligence_row") as f, \
             patch("worker.ai_intelligence_scan.schedule_async_scan",
                   create=True) as scan:
            f.return_value = None
            result = load_intelligence("example.com")
            assert result is None
            scan.assert_called_once()
            assert "no-record" in str(scan.call_args)


class TestSecondCrawlUsesCache:
    def test_fresh_record_no_scan(self):
        from worker.site_crawl import load_intelligence
        fresh_row = {
            "intelligence": {"feeds": [], "structural_map": [],
                              "sd_fingerprint": {}, "politics": {}},
            "refreshed_at": dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1),
            "confidence": 0.9, "consecutive_errors": 0,
            "drift_signals": {},
        }
        with patch("worker.site_crawl._fetch_intelligence_row") as f, \
             patch("worker.ai_intelligence_scan.schedule_async_scan",
                   create=True) as scan:
            f.return_value = fresh_row
            result = load_intelligence("example.com")
            assert result is not None
            scan.assert_not_called()


class TestStaleCrawlTriggersRefreshButUsesRecord:
    def test_still_returns_intel_for_stale_record(self):
        from worker.site_crawl import load_intelligence
        stale_row = {
            "intelligence": {"feeds": [], "structural_map": [],
                              "sd_fingerprint": {}, "politics": {}},
            "refreshed_at": dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31),
            "confidence": 0.9, "consecutive_errors": 0,
            "drift_signals": {},
        }
        with patch("worker.site_crawl._fetch_intelligence_row") as f, \
             patch("worker.ai_intelligence_scan.schedule_async_scan",
                   create=True) as scan:
            f.return_value = stale_row
            result = load_intelligence("example.com")
            assert result is not None  # still usable
            scan.assert_called_once()  # schedule refresh
            assert "age" in str(scan.call_args)


class TestFeatureFlagGate:
    def test_wrapper_returns_none_when_flag_off(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as m:
            m.return_value = False
            result = crawl_with_intelligence("https://example.com")
            assert result is None

    def test_wrapper_runs_when_flag_on(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            load.return_value = {"feeds": [], "structural_map": [],
                                  "sd_fingerprint": {}, "politics": {}}
            crawl.return_value = MagicMock(to_dict=lambda: {"stats": {}})
            result = crawl_with_intelligence("https://example.com")
            assert result is not None
            assert "stats" in result