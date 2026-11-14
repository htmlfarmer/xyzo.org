"""Tests for collabd.state — the local sqlite-backed counter store."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from collabd.state import State  # noqa: E402


class TestState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.tmp.close()
        self.state = State(path=self.tmp.name)

    def tearDown(self):
        os.unlink(self.tmp.name)

    def test_incr_creates_and_increments(self):
        self.assertEqual(self.state.get("jobs_done"), 0)
        self.state.incr("jobs_done")
        self.state.incr("jobs_done", 4)
        self.assertEqual(self.state.get("jobs_done"), 5)

    def test_incr_different_keys(self):
        self.state.incr("jobs_done", 3)
        self.state.incr("jobs_failed", 1)
        self.assertEqual(self.state.get("jobs_done"), 3)
        self.assertEqual(self.state.get("jobs_failed"), 1)

    def test_snapshot(self):
        self.state.incr("a", 1)
        self.state.incr("b", 2)
        snap = self.state.snapshot()
        self.assertEqual(snap, {"a": 1, "b": 2})

    def test_log_event(self):
        self.state.log_event("register", "node_id=abc")
        events = self.state.recent_events(10)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["kind"], "register")
        self.assertEqual(events[0]["detail"], "node_id=abc")

    def test_recent_events_sorted_desc(self):
        import time
        self.state.log_event("first")
        time.sleep(0.01)
        self.state.log_event("second")
        events = self.state.recent_events(10)
        # newest first.
        self.assertEqual(events[0]["kind"], "second")
        self.assertEqual(events[1]["kind"], "first")


if __name__ == "__main__":
    unittest.main()
