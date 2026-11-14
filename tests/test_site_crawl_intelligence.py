"""Tests for crawl_with_intelligence wrapper.

We don't actually crawl in tests — we mock study_url and crawl_site
to verify the wrapper applies hints correctly."""
from unittest.mock import patch, MagicMock
from worker.site_crawl import crawl_with_intelligence


class TestCrawlWithIntelligence:
    def test_returns_none_when_intelligence_disabled(self):
        with patch("worker.site_crawl.is_enabled") as m:
            m.return_value = False
            result = crawl_with_intelligence("https://x.com")
            assert result is None

    def test_loads_intelligence_when_enabled(self):
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            load.return_value = {"feeds": [], "structural_map": [],
                                  "sd_fingerprint": {}, "politics": {}}
            crawl.return_value = MagicMock(to_dict=lambda: {"stats": {}})
            result = crawl_with_intelligence("https://x.com")
            load.assert_called_once()
            crawl.assert_called_once()

    def test_passes_hints_to_crawl_site(self):
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            intel = {"feeds": [{"href": "https://x.com/feed"}],
                     "structural_map": [], "sd_fingerprint": {},
                     "politics": {}}
            load.return_value = intel
            crawl.return_value = MagicMock(to_dict=lambda: {})
            crawl_with_intelligence("https://x.com")
            call_kwargs = crawl.call_args.kwargs
            assert "intelligence" in call_kwargs
            assert call_kwargs["intelligence"]["feeds"][0]["href"] == \
                   "https://x.com/feed"

    def test_load_intelligence_returns_none_triggers_legacy(self):
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            load.return_value = None  # no record yet
            crawl.return_value = MagicMock(to_dict=lambda: {})
            crawl_with_intelligence("https://x.com")
            # Should still call crawl_site, just without intelligence
            assert crawl.called


class TestLoadIntelligence:
    def test_returns_none_on_db_error(self):
        from worker.site_crawl import load_intelligence
        with patch("worker.site_crawl._fetch_intelligence_row") as f:
            f.side_effect = Exception("db down")
            result = load_intelligence("example.com")
            assert result is None

    def test_returns_intel_json_on_success(self):
        from worker.site_crawl import load_intelligence
        fake_row = {"intelligence": {"feeds": [], "structural_map": [],
                                       "sd_fingerprint": {}, "politics": {}},
                    "refreshed_at": "2026-09-01", "confidence": 0.9,
                    "consecutive_errors": 0, "drift_signals": {}}
        with patch("worker.site_crawl._fetch_intelligence_row") as f:
            f.return_value = fake_row
            result = load_intelligence("example.com")
            assert result is not None
            assert "feeds" in result


class TestEmbeddingsWiring:
    """Task 20: crawl_with_intelligence wires embeddings + drift signals.

    We mock compute_event_embeddings and update_drift_signals at the
    worker.site_crawl module boundary so we don't actually call the
    real sentence-transformers pipeline.
    """

    def _enable_flag_and_crawl(self, intelligence_politics=None,
                                events=None):
        """Helper: enable flag + load_intelligence + crawl_site mocked."""
        if intelligence_politics is None:
            intelligence_politics = {"tier": "commercial"}
        intel = {"feeds": [], "structural_map": [],
                 "sd_fingerprint": {}, "politics": intelligence_politics}
        if events is None:
            events = [{"title": "T",
                       "starts_at": "2026-09-06T19:00:00Z"}]
        return intel, events

    def test_crawl_result_triggers_embeddings_when_enabled(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.compute_event_embeddings") as embed:
            flag.return_value = True
            intel, events = self._enable_flag_and_crawl()
            load.return_value = intel
            crawl.return_value = MagicMock(
                to_dict=lambda: {"events": events, "stats": {}})
            crawl_with_intelligence("https://x.com")
            embed.assert_called_once()
            # Host and tier must be passed explicitly
            call_args = embed.call_args
            events_arg = (call_args.args[0] if call_args.args
                          else call_args.kwargs["events"])
            assert events_arg == events
            passed_host = (call_args.args[1] if len(call_args.args) > 1
                           else call_args.kwargs.get("host"))
            passed_tier = (call_args.args[2] if len(call_args.args) > 2
                           else call_args.kwargs.get("tier"))
            assert passed_host == "x.com"
            assert passed_tier == "commercial"

    def test_crawl_skips_embeddings_when_disabled(self):
        """When the event list is empty, embeddings step is skipped."""
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.compute_event_embeddings") as embed:
            flag.return_value = True
            intel, events = self._enable_flag_and_crawl(events=[])
            load.return_value = intel
            crawl.return_value = MagicMock(
                to_dict=lambda: {"events": events, "stats": {}})
            crawl_with_intelligence("https://x.com")
            embed.assert_not_called()

    def test_crawl_skips_merge_when_tier_is_gov(self):
        """compute_event_embeddings MUST NOT call mark_duplicate for gov."""
        from worker.site_crawl import compute_event_embeddings
        try:
            from worker.embeddings_dedup import mark_duplicate  # noqa: F401
            from worker.embeddings_dedup import find_near_duplicates
        except ImportError:
            # embeddings_dedup module may not exist yet; skip integration
            import pytest
            pytest.skip("worker.embeddings_dedup not available")
        try:
            from worker.embeddings import is_available  # noqa: F401
        except ImportError:
            import pytest
            pytest.skip("worker.embeddings not available")

        events = [{"title": "City Council Meeting",
                   "starts_at": "2026-09-06T19:00:00Z",
                   "source_url": "https://city.gov/events"}]
        with patch("worker.embeddings.encode_events_batch") as enc, \
             patch("worker.embeddings_dedup.find_near_duplicates") as fn, \
             patch("worker.embeddings_dedup.mark_duplicate") as md, \
             patch("worker.embeddings.is_available") as ia, \
             patch("api.src.xyzo_features.is_enabled") as flag:
            ia.return_value = True
            flag.return_value = True
            enc.return_value = [[0.1] * 384]
            fn.return_value = [{"id": 99, "sim": 0.98}]
            count = compute_event_embeddings(events, "city.gov",
                                               tier="gov")
            md.assert_not_called()
            # find_near_duplicates (read-only) still runs
            fn.assert_called()
            # Encoding work still counted
            assert count == 1

    def test_crawl_logs_warning_when_gov_merge_skipped(self):
        """When tier=gov and merge is skipped, logger emits WARNING."""
        import logging
        from worker.site_crawl import compute_event_embeddings
        try:
            from worker.embeddings_dedup import find_near_duplicates
        except ImportError:
            import pytest
            pytest.skip("worker.embeddings_dedup not available")
        try:
            from worker.embeddings import is_available  # noqa: F401
        except ImportError:
            import pytest
            pytest.skip("worker.embeddings not available")

        events = [{"title": "Public Hearing",
                   "starts_at": "2026-09-06T19:00:00Z",
                   "source_url": "https://university.edu/events"}]
        with patch("worker.embeddings.encode_events_batch") as enc, \
             patch("worker.embeddings_dedup.find_near_duplicates") as fn, \
             patch("worker.embeddings_dedup.mark_duplicate") as md, \
             patch("worker.embeddings.is_available") as ia, \
             patch("api.src.xyzo_features.is_enabled") as flag:
            ia.return_value = True
            flag.return_value = True
            enc.return_value = [[0.1] * 384]
            fn.return_value = [{"id": 7, "sim": 0.97}]
            with patch("worker.site_crawl.log") as logmock:
                compute_event_embeddings(events, "university.edu",
                                          tier="university")
                # At least one WARNING call about gov/university merge skip
                warns = [c for c in logmock.warning.call_args_list
                         if "merge" in str(c).lower()
                         or "gov" in str(c).lower()
                         or "university" in str(c).lower()
                         or "tier" in str(c).lower()]
                assert warns, "expected a WARNING log for tier-protected merge"
            md.assert_not_called()

    def test_crawl_skips_embeddings_when_flag_disabled_for_gov(self):
        """If embedding_dedup flag is disabled (which it should be for
        gov by tier_overrides), the function returns 0 without encoding."""
        from worker.site_crawl import compute_event_embeddings
        events = [{"title": "Town Hall",
                   "starts_at": "2026-09-06T19:00:00Z",
                   "source_url": "https://city.gov/events"}]
        with patch("api.src.xyzo_features.is_enabled") as flag, \
             patch("worker.embeddings.encode_events_batch") as enc, \
             patch("worker.embeddings_dedup.find_near_duplicates") as fn, \
             patch("worker.embeddings_dedup.mark_duplicate") as md:
            flag.return_value = False
            count = compute_event_embeddings(events, "city.gov",
                                              tier="gov")
            flag.assert_called_with("embedding_dedup", "city.gov", "gov")
            assert count == 0
            enc.assert_not_called()
            fn.assert_not_called()
            md.assert_not_called()

    def test_update_drift_signals_called_after_crawl(self):
        """update_drift_signals is called once per crawl regardless of tier."""
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.compute_event_embeddings") as embed, \
             patch("worker.site_crawl.update_drift_signals") as drift:
            flag.return_value = True
            intel, events = self._enable_flag_and_crawl()
            load.return_value = intel
            crawl.return_value = MagicMock(
                to_dict=lambda: {"events": events,
                                 "pages": [{"json_ld_events": [],
                                             "heuristic_events": [],
                                             "ai_events": []}],
                                 "feeds": [],
                                 "stats": {"events_found": 1}})
            embed.return_value = 1
            crawl_with_intelligence("https://x.com")
            drift.assert_called_once()
            call_args = drift.call_args
            passed_host = (call_args.args[0] if call_args.args
                           else call_args.kwargs["host"])
            assert passed_host == "x.com"

    def test_tier_derived_from_seed_url_not_intel_row(self):
        """Tier MUST come from tier_for_url(seed_url), not intel['politics'].

        Regression test for HIGH-severity bug: the AI scan JSONB schema
        has no `tier` field under `politics`, so reading politics.tier
        always yields None and silently bypasses the gov/university
        guard in compute_event_embeddings.

        With tier_for_url mocked to return 'gov', the helper inside
        crawl_with_intelligence MUST be called with tier='gov', which
        causes compute_event_embeddings to log a WARNING and skip
        mark_duplicate.
        """
        try:
            from worker.embeddings_dedup import find_near_duplicates
            from worker.embeddings_dedup import mark_duplicate  # noqa: F401
        except ImportError:
            import pytest
            pytest.skip("worker.embeddings_dedup not available")
        try:
            from worker.embeddings import is_available  # noqa: F401
        except ImportError:
            import pytest
            pytest.skip("worker.embeddings not available")

        # IMPORTANT: intel dict has NO politics.tier (the AI scan schema
        # doesn't carry one). With the bug, tier would default to
        # 'commercial'; with the fix, tier comes from tier_for_url.
        intel = {"feeds": [], "structural_map": [], "sd_fingerprint": {},
                 "politics": {}}
        events = [{"title": "City Council",
                   "starts_at": "2026-09-06T19:00:00Z",
                   "source_url": "https://city.gov/events"}]
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.tier_for_url") as tfu, \
             patch("worker.embeddings.encode_events_batch") as enc, \
             patch("worker.embeddings_dedup.find_near_duplicates") as fn, \
             patch("worker.embeddings_dedup.mark_duplicate") as md, \
             patch("worker.embeddings.is_available") as ia, \
             patch("api.src.xyzo_features.is_enabled") as xf:
            flag.return_value = True
            tfu.return_value = "gov"  # canonical tier source returns gov
            load.return_value = intel
            crawl.return_value = MagicMock(
                to_dict=lambda: {"events": events, "stats": {}})
            ia.return_value = True
            xf.return_value = True  # embedding_dedup flag enabled
            enc.return_value = [[0.1] * 384]
            fn.return_value = [{"id": 99, "sim": 0.98}]
            with patch("worker.site_crawl.log") as logmock:
                crawl_with_intelligence("https://city.gov/events")
                # tier_for_url MUST be called with the seed URL
                tfu.assert_called_once_with("https://city.gov/events")
                # Gov/university guard must fire:
                # mark_duplicate must NOT be called
                md.assert_not_called()
                # find_near_duplicates still runs (read-only)
                fn.assert_called()
                # A WARNING must be logged about skipping the merge
                warns = [c for c in logmock.warning.call_args_list
                         if "merge" in str(c).lower()
                         or "gov" in str(c).lower()
                         or "university" in str(c).lower()
                         or "tier" in str(c).lower()]
                assert warns, ("expected a WARNING log for "
                               "tier-protected merge")

    def test_falls_back_to_commercial_when_tier_for_url_raises(self):
        """If tier_for_url itself raises, crawl proceeds with tier='commercial'.

        Defensive fallback: tier derivation is best-effort. We never want
        to crash the crawl because the URL classifier itself is broken —
        falling back to 'commercial' is the conservative default (the
        helper still has its own guards, and silent protection drop is
        acceptable here because the failure is in the classifier itself,
        not in the JSONB shape).
        """
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.tier_for_url") as tfu, \
             patch("worker.site_crawl.compute_event_embeddings") as embed:
            flag.return_value = True
            tfu.side_effect = Exception("classifier broken")
            intel, events = self._enable_flag_and_crawl()
            load.return_value = intel
            crawl.return_value = MagicMock(
                to_dict=lambda: {"events": events, "stats": {}})
            embed.return_value = 1
            # Should NOT raise
            result = crawl_with_intelligence("https://x.com")
            assert result is not None
            # embed must be called once with tier='commercial' (fallback)
            embed.assert_called_once()
            call_args = embed.call_args
            passed_tier = (call_args.args[2] if len(call_args.args) > 2
                           else call_args.kwargs.get("tier"))
            assert passed_tier == "commercial"