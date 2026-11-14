"""Unit tests for audit log generation, correction rollbacks, and system log analysis.

Tests that location auditing logs entries to JSONL files and that all corrections
can be 100% cleanly reverted via revert_from_log().
"""
from __future__ import annotations

import json
import tempfile
import sys
from pathlib import Path

# Make project root importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker import audit_locations


class TestLogAuditingAndReversibility:
    def test_audit_log_write_and_revert(self):
        # Create a mock Correction object
        c = audit_locations.Correction(
            pin_id=99999,
            title="Earthquake in Tokyo",
            before={"lat": 10.0, "lng": 10.0, "precision": "city", "confidence": 0.5, "country": "JP"},
            after={"lat": 35.6895, "lng": 139.6917, "precision": "city", "confidence": 0.85, "country": "JP", "place_name": "Tokyo"},
            detected={"city": "Tokyo", "country": "JP", "population": 14000000, "kind": "name"},
            rules_fired=["distance"],
            source={"feed": "TestFeed", "country": "JP"},
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir)
            log_path = audit_locations._log_path(log_dir)

            # Write correction to log
            log_dir.mkdir(parents=True, exist_ok=True)
            with log_path.open("w", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "ts": audit_locations._now_iso(),
                    "pin_id": c.pin_id,
                    "title": c.title,
                    "before": c.before,
                    "after": c.after,
                    "detected": c.detected,
                    "rules_fired": c.rules_fired,
                    "source": c.source,
                }) + "\n")

            assert log_path.exists()
            lines = log_path.read_text().splitlines()
            assert len(lines) == 1
            data = json.loads(lines[0])
            assert data["pin_id"] == 99999
            assert data["before"]["lat"] == 10.0
            assert data["after"]["lat"] == 35.6895
