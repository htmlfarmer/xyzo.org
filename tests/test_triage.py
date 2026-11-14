"""Unit tests for automated community triage engine (worker.triage_community).

Validates dry-run execution, user quality report processing, and request auto-resolution.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make project root importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker import triage_community


class TestCommunityTriage:
    def test_dry_run_triage_executes_without_error(self):
        res = triage_community.run_triage(apply=False)
        assert res["applied"] is False
        assert "resolved_requests" in res
        assert "paywalls_flagged" in res
        assert "re_eval_queued" in res

    def test_triage_queued_requests_dry_run(self):
        count = triage_community.triage_queued_requests(apply=False)
        assert isinstance(count, int)
        assert count >= 0

    def test_triage_quality_reports_dry_run(self):
        res = triage_community.triage_quality_reports(apply=False)
        assert "paywalls_flagged" in res
        assert "re_eval_queued" in res
