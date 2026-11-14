#!/usr/bin/env python3
"""
Tests for worker.timer_watchdog — specifically the `failed`-unit check
added 2026-11-01.

The bug these pin: a ONESHOT that exits non-zero was invisible to every
check the watchdog had. `check_service_stuck()` only inspects services
that are RUNNING (a broken oneshot is not running, so it reported
"not running" and passed) and `check_all_timers()` inspects the TIMER,
which fires perfectly and then waits for the next slot. Nothing ran
`systemctl --failed`, so `xyzo-graph-features` stayed red for a month
with `news_event_graph_features` frozen at 2026-10-02, and
`xyzo-nightly` died every night at learn.py:1189.

Run with: python -m pytest worker/tests/test_timer_watchdog.py -v
"""
from unittest.mock import patch, MagicMock

from worker.timer_watchdog import (
    AUTO_RECOVER_FAILED,
    CRITICAL_TIMERS,
    check_failed_units,
    format_report,
    recover_failed,
)

FAILED_OUTPUT = """\
● xyzo-nightly.service loaded failed failed Xyzo Nightly Automation
● xyzo-trending.service loaded failed failed Xyzo trending producers
"""

MIXED_OUTPUT = """\
● xyzo-nightly.service loaded failed failed Xyzo Nightly Automation
● some-other-vhost.service loaded failed failed Someone else's problem
"""


def _run(stdout: str, returncode: int = 0) -> MagicMock:
    m = MagicMock()
    m.stdout = stdout
    m.stderr = ""
    m.returncode = returncode
    return m


class TestCheckFailedUnits:
    """check_failed_units() — the check that did not exist before."""

    @patch("worker.timer_watchdog.subprocess.run")
    def test_detects_failed_xyzo_units(self, mock_run):
        mock_run.return_value = _run(FAILED_OUTPUT)

        units = check_failed_units()

        assert [u["name"] for u in units] == [
            "xyzo-nightly.service",
            "xyzo-trending.service",
        ]
        # It must actually ask systemd --failed, not is-active (which a
        # oneshot passes while it is merely between runs).
        args = mock_run.call_args[0][0]
        assert "--failed" in args

    @patch("worker.timer_watchdog.subprocess.run")
    def test_ignores_other_projects_units(self, mock_run):
        """This box hosts many vhosts; only xyzo-* is ours to watch."""
        mock_run.return_value = _run(MIXED_OUTPUT)

        assert [u["name"] for u in check_failed_units()] == ["xyzo-nightly.service"]

    @patch("worker.timer_watchdog.subprocess.run")
    def test_empty_when_nothing_failed(self, mock_run):
        mock_run.return_value = _run("")

        assert check_failed_units() == []

    @patch("worker.timer_watchdog.subprocess.run")
    def test_tolerates_bullet_and_blank_lines(self, mock_run):
        """systemctl --no-legend still prefixes a bullet glyph."""
        mock_run.return_value = _run("\n● xyzo-nightly.service  loaded failed failed\n\n")

        assert [u["name"] for u in check_failed_units()] == ["xyzo-nightly.service"]


class TestRecoverFailed:
    """recover_failed() — recovery must be selective and non-blocking."""

    @patch("worker.timer_watchdog.subprocess.run")
    def test_refuses_to_touch_units_not_marked_safe(self, mock_run):
        """nightly is a 4-hour off-schedule AI cycle: report, never restart."""
        mock_run.return_value = _run("", returncode=0)

        recovered = recover_failed([{"name": "xyzo-nightly.service"}])

        assert recovered == []
        mock_run.assert_not_called()

    @patch("worker.timer_watchdog.subprocess.run")
    def test_recovers_a_safe_unit(self, mock_run):
        mock_run.return_value = _run("", returncode=0)

        recovered = recover_failed([{"name": "xyzo-graph-features.service"}])

        assert recovered == ["xyzo-graph-features.service"]
        cmds = [c[0][0] for c in mock_run.call_args_list]
        assert any("reset-failed" in c for c in cmds)
        assert any("start" in c for c in cmds)

    @patch("worker.timer_watchdog.subprocess.run")
    def test_recovery_uses_no_block(self, mock_run):
        """`systemctl start` on a oneshot BLOCKS (graph-features ~6 min,
        trending ~30 min) and this watchdog runs from a */2 cron — a
        blocking recovery would pile up overlapping runs."""
        mock_run.return_value = _run("", returncode=0)

        recover_failed([{"name": "xyzo-trending.service"}])

        start_cmd = next(c[0][0] for c in mock_run.call_args_list
                         if "start" in c[0][0])
        assert "--no-block" in start_cmd

    @patch("worker.timer_watchdog.subprocess.run")
    def test_reports_failure_when_systemd_refuses(self, mock_run):
        mock_run.return_value = _run("", returncode=1)

        assert recover_failed([{"name": "xyzo-graph-features.service"}]) == []

    def test_the_two_fast_jobs_are_the_auto_recoverable_ones(self):
        """Guards the policy: only idempotent, short jobs are auto-run."""
        assert AUTO_RECOVER_FAILED == {
            "xyzo-graph-features.service",
            "xyzo-trending.service",
        }
        assert "xyzo-nightly.service" not in AUTO_RECOVER_FAILED


class TestWiredIntoTheWatchList:
    """Every unit we may auto-recover must also have its TIMER watched —
    otherwise a dead timer would stop producing failures and the
    recovery path would never fire again."""

    def test_both_recovered_units_are_in_the_timer_list(self):
        for unit in AUTO_RECOVER_FAILED:
            timer = unit.replace(".service", ".timer")
            assert timer in CRITICAL_TIMERS, f"{timer} is not watched"


class TestReport:
    """format_report() must surface failed units and the refusal."""

    def test_reports_failed_units(self):
        out = format_report(
            timers=[], services=[],
            failed_units=[{"name": "xyzo-nightly.service"}],
        )
        assert "FAILED UNITS" in out
        assert "xyzo-nightly.service" in out

    def test_marks_units_recovered_on_this_run(self):
        out = format_report(
            timers=[], services=[],
            failed_units=[{"name": "xyzo-graph-features.service"}],
            recovered_units=["xyzo-graph-features.service"],
        )
        assert "RE-RUNNING" in out

    def test_says_none_when_healthy(self):
        out = format_report(timers=[], services=[], failed_units=[])
        assert "none" in out

    def test_omits_the_section_entirely_when_not_supplied(self):
        """Backwards compatible: callers that predate this check."""
        out = format_report(timers=[], services=[])
        assert "FAILED UNITS" not in out
