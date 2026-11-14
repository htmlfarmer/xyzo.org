"""Tests for embeddings_dedup — pgvector cosine similarity search.

These tests patch the module-local `_search` and `_execute` helpers, so
no real DB connection is ever attempted.
"""
from unittest.mock import patch

from worker.embeddings_dedup import (
    find_near_duplicates,
    mark_duplicate,
    DEFAULT_THRESHOLD,
    REVIEW_THRESHOLD_LOWER,
)


# ── find_near_duplicates ────────────────────────────────────────────


class TestFindNearDuplicates:
    def test_empty_when_no_events_match(self):
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = []
            result = find_near_duplicates(
                "event-1", [0.1] * 384,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert result == []

    def test_returns_below_threshold_when_no_close_match(self):
        """sim=0.5 sits below REVIEW_THRESHOLD_LOWER (0.85), so the
        match is treated as noise and dropped from results."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": 42, "title": "Far away event", "sim": 0.5,
                 "source_url": "https://x.com/a"}
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert result == []  # below REVIEW_THRESHOLD_LOWER

    def test_returns_above_threshold(self):
        """sim=0.95 sits above DEFAULT_THRESHOLD (0.92) -> band=auto."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": 42, "title": "Same event", "sim": 0.95,
                 "source_url": "https://x.com/a"}
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert len(result) == 1
            assert result[0]["sim"] == 0.95
            assert result[0]["band"] == "auto"

    def test_caps_results(self):
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": i, "title": f"E{i}", "sim": 0.95 - i * 0.001,
                 "source_url": f"https://x.com/{i}"}
                for i in range(20)
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85, limit=5,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert len(result) == 5
            # Every returned match must carry a band key.
            assert all("band" in m for m in result)
            # All 20 sims (0.95..0.931) are above DEFAULT_THRESHOLD so
            # the first 5 returned are all in the auto band.
            assert all(m["band"] == "auto" for m in result)

    def test_review_band_attached_when_between_thresholds(self):
        """sim=0.88 sits between REVIEW_THRESHOLD_LOWER (0.85) and
        DEFAULT_THRESHOLD (0.92) -> band=review."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": 42, "title": "Maybe same event", "sim": 0.88,
                 "source_url": "https://x.com/a"}
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert len(result) == 1
            assert result[0]["band"] == "review"
            assert result[0]["sim"] == 0.88

    # ── extra defensive tests ───────────────────────────────────────

    def test_excludes_input_event_id_from_results(self):
        """The event we're searching for must never come back as its
        own near-duplicate."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": "self-id", "title": "Self", "sim": 0.99,
                 "source_url": "https://x.com/self"},
                {"id": 42, "title": "Other", "sim": 0.95,
                 "source_url": "https://x.com/other"},
            ]
            result = find_near_duplicates(
                "self-id", [0.1] * 384, threshold=0.85,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert len(result) == 1
            assert result[0]["id"] == 42

    def test_empty_vector_short_circuits_to_empty(self):
        """Passing an empty vector must not hit _search at all."""
        with patch("worker.embeddings_dedup._search") as search:
            result = find_near_duplicates(
                "e1", [], starts_at="2026-09-06T19:00:00Z",
            )
            assert result == []
            search.assert_not_called()

    def test_search_db_exception_returns_empty(self):
        """If _search returns [] (its own exception handler), the
        caller must receive []."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = []
            result = find_near_duplicates(
                "e1", [0.1] * 384, starts_at="2026-09-06T19:00:00Z",
            )
            assert result == []

    def test_passes_threshold_and_limit_through(self):
        """Custom threshold + limit are forwarded to _search."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = []
            find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.88, limit=3,
                starts_at="2026-09-06T19:00:00Z",
            )
            # _search is called with (vector_str, starts_at, threshold, limit)
            args = search.call_args.args
            assert args[2] == 0.88
            assert args[3] == 3

    def test_vector_serialised_as_pgvector_string(self):
        """The vector is serialised as '[v1,v2,...]' with no spaces."""
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = []
            find_near_duplicates(
                "e1", [0.1, 0.2, -0.3], starts_at="2026-09-06T19:00:00Z",
            )
            vector_str = search.call_args.args[0]
            assert vector_str == "[0.1,0.2,-0.3]"
            assert " " not in vector_str


# ── mark_duplicate ──────────────────────────────────────────────────


class TestMarkDuplicate:
    def test_writes_merged_into(self):
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(lower_id=10, higher_id=20)
            exec.assert_called_once()
            sql = exec.call_args.args[0]
            assert "merged_into" in sql
            assert exec.call_args.args[1] == 20
            assert exec.call_args.args[2] == 10

    # ── extra defensive tests ───────────────────────────────────────

    def test_db_exception_is_swallowed(self):
        """A failure during the UPDATE must not crash the caller."""
        with patch("worker.embeddings_dedup._execute") as exec:
            exec.side_effect = Exception("write failed")
            # Should not raise
            mark_duplicate(lower_id=10, higher_id=20)

    def test_requires_review_when_both_gov(self):
        """If BOTH events come from gov tier, do NOT auto-merge — must
        require manual review (per standing constraint)."""
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier="gov", target_tier="gov",
            )
            exec.assert_not_called()

    def test_requires_review_when_both_university(self):
        """Same protection for university-tier events."""
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier="university", target_tier="university",
            )
            exec.assert_not_called()

    def test_requires_review_for_gov_and_university(self):
        """gov + university = both protected, must require review."""
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier="gov", target_tier="university",
            )
            exec.assert_not_called()

    def test_allows_merge_when_only_one_protected(self):
        """If only ONE side is gov/university (the other is commercial),
        we trust the caller — they may have a legitimate reason to merge.
        The strictest protection fires only when BOTH are protected."""
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier="gov", target_tier="commercial",
            )
            exec.assert_called_once()

    def test_allows_merge_for_two_commercial(self):
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier="commercial", target_tier="community",
            )
            exec.assert_called_once()

    def test_logs_warning_when_tier_omitted(self):
        """When either tier is None and a merge is about to proceed,
        a WARNING must be logged naming the missing tier(s) so the
        silent unprotected merge is visible to ops."""
        with patch("worker.embeddings_dedup._execute") as exec, \
                patch("worker.embeddings_dedup.log") as log:
            mark_duplicate(lower_id=10, higher_id=20)
            exec.assert_called_once()
            log.warning.assert_called_once()
            # Format must reference lower_id + higher_id so the log
            # line is unambiguously tied to the merge that just ran.
            fmt = log.warning.call_args.args[0]
            assert "lower_id" in fmt
            assert "higher_id" in fmt
            # And it must mention gov/university so log readers can
            # tell what protection was disabled.
            assert "gov" in fmt and "university" in fmt

    def test_logs_warning_when_only_source_tier_omitted(self):
        """Only the source tier is None — still a WARNING (we can't
        run the guard on the lower side)."""
        with patch("worker.embeddings_dedup._execute") as exec, \
                patch("worker.embeddings_dedup.log") as log:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier=None, target_tier="commercial",
            )
            exec.assert_called_once()
            log.warning.assert_called_once()

    def test_no_warning_when_both_tiers_supplied(self):
        """When both tiers are present (and at least one is not a
        protected tier), no missing-tier WARNING is emitted. The
        gov/university refusal path logs its own WARNING separately."""
        with patch("worker.embeddings_dedup._execute") as exec, \
                patch("worker.embeddings_dedup.log") as log:
            mark_duplicate(
                lower_id=10, higher_id=20,
                source_tier="commercial", target_tier="community",
            )
            exec.assert_called_once()
            log.warning.assert_not_called()

    def test_docstring_documents_id_tier_correspondence(self):
        """The module docstring / mark_duplicate docstring must
        unambiguously map lower_id <-> source_tier and higher_id <->
        target_tier."""
        from worker import embeddings_dedup as mod
        doc = (mod.__doc__ or "") + "\n" + (mod.mark_duplicate.__doc__ or "")
        # All four labels must appear so the mapping is explicit.
        for needle in (
            "lower_id =",
            "higher_id =",
            "source_tier =",
            "target_tier =",
        ):
            assert needle in doc, (
                f"expected {needle!r} in docstring; got:\n{doc}"
            )


# ── constants ───────────────────────────────────────────────────────


class TestConstants:
    def test_default_threshold_in_range(self):
        assert 0.0 < DEFAULT_THRESHOLD < 1.0

    def test_default_threshold_is_0_92(self):
        # Spec-locked value
        assert DEFAULT_THRESHOLD == 0.92

    def test_review_threshold_lower_in_range(self):
        assert 0.0 < REVIEW_THRESHOLD_LOWER < 1.0

    def test_review_threshold_lower_at_or_above_spec_default(self):
        """Standing constraint: review threshold must be at least 0.85
        (spec default)."""
        assert REVIEW_THRESHOLD_LOWER >= 0.85

    def test_default_threshold_above_review_threshold(self):
        """Sanity: auto-merge band sits strictly above review band."""
        assert DEFAULT_THRESHOLD > REVIEW_THRESHOLD_LOWER