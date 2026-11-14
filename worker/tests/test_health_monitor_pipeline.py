"""Pipeline-stage freshness check added after the 2026-09-29 outage.

That outage was invisible to every existing health stat because they all
watch the FETCH layer: fetch kept inserting (so leases/errors/fetched_last_hour
all looked healthy) while fetch_all() never returned, so auto_categorize never
ran, 75k articles piled up at status='pending' with no coordinates, and the map
showed only pre-outage pins for 20+ hours.

`pipeline_stuck()` is the check that would have caught it. Pure function, no
DB required.
"""
from __future__ import annotations

from worker.health_monitor import pipeline_stuck


def _stats(backlog: int, last_30m: int, stale_minutes=None) -> dict:
    return {
        "pending_backlog": backlog,
        "autocat_last_30m": last_30m,
        "autocat_stale_minutes": stale_minutes,
    }


class TestPipelineStuck:
    def test_backlog_growing_and_silent_is_stuck(self):
        """The outage signature: 75k queued, auto_categorize silent."""
        assert pipeline_stuck(_stats(75_000, 0, stale_minutes=1200)) is True

    def test_busy_pipeline_is_not_stuck(self):
        """A backlog is fine while the stage is actively draining it."""
        assert pipeline_stuck(_stats(71_801, 4_637, stale_minutes=0)) is False

    def test_empty_queue_is_never_stuck(self):
        """Nothing to do is not an outage — must not alert when idle."""
        assert pipeline_stuck(_stats(0, 0, stale_minutes=None)) is False

    def test_small_backlog_is_not_stuck(self):
        """Normal inter-cycle slop must not trip the alert."""
        assert pipeline_stuck(_stats(1_000, 0, stale_minutes=45)) is False
        assert pipeline_stuck(_stats(999, 0, stale_minutes=10_000)) is False

    def test_backlog_requires_silence_to_alert(self):
        """Backlog alone is not enough — the drain must actually be quiet."""
        assert pipeline_stuck(_stats(75_000, 1, stale_minutes=45)) is False

    def test_missing_keys_do_not_crash(self):
        """get_health_stats() may be partial in degraded conditions."""
        assert pipeline_stuck({}) is False
