"""Unit tests for collabd.runner — the sandboxed subprocess executor.

Stdlib only; no pytest required (we use plain `assert` + a runner script).

Run with:  python3 -m unittest collab.tests.test_runner
"""
from __future__ import annotations

import os
import sys
import unittest

# Make collabd importable when running this file directly.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from collabd.runner import run_shell_job  # noqa: E402


class TestRunner(unittest.TestCase):
    def test_hello(self):
        r = run_shell_job({"command": "echo hello"}, timeout_s=5)
        self.assertEqual(r.exit_code, 0)
        self.assertIn("hello", r.stdout)
        self.assertIsNone(r.error_message)

    def test_nonzero_exit(self):
        r = run_shell_job({"command": "exit 7"}, timeout_s=5)
        self.assertEqual(r.exit_code, 7)
        self.assertIsNone(r.error_message)

    def test_timeout(self):
        r = run_shell_job({"command": "sleep 10"}, timeout_s=1)
        self.assertIsNone(r.exit_code)
        self.assertIsNotNone(r.error_message)
        self.assertIn("timeout", r.error_message.lower())

    def test_env_override(self):
        r = run_shell_job(
            {"command": "echo $FOO", "env": {"FOO": "bar"}},
            timeout_s=5,
        )
        self.assertEqual(r.exit_code, 0)
        self.assertIn("bar", r.stdout)

    def test_strips_dangerous_env(self):
        r = run_shell_job(
            {
                "command": "echo ld=$LD_PRELOAD",
                "env": {"LD_PRELOAD": "/tmp/evil.so"},
            },
            timeout_s=5,
        )
        self.assertEqual(r.exit_code, 0)
        # LD_PRELOAD should be stripped, not echoed.
        self.assertNotIn("/tmp/evil.so", r.stdout)

    def test_max_output_truncation(self):
        # Generate > 1KB of stdout; expect truncation marker.
        r = run_shell_job(
            {"command": "yes x | head -c 2000", "max_output_kb": 1},
            timeout_s=5,
        )
        self.assertEqual(r.exit_code, 0)
        self.assertTrue(r.truncated)
        self.assertIn("truncated", r.stdout)

    def test_list_command(self):
        r = run_shell_job({"command": ["echo", "abc"]}, timeout_s=5)
        self.assertEqual(r.exit_code, 0)
        self.assertIn("abc", r.stdout)

    def test_missing_executable(self):
        r = run_shell_job({"command": "/no/such/binary/zzz"}, timeout_s=5)
        # Popen succeeds; the shell exits 127 with stderr "not found".
        # We don't fail noisily on this — exit_code=127 is enough signal.
        self.assertEqual(r.exit_code, 127)
        self.assertIn("not found", r.stderr.lower() + r.stdout.lower())

    def test_empty_command(self):
        r = run_shell_job({"command": []}, timeout_s=5)
        self.assertIsNotNone(r.error_message)

    def test_bad_command_type(self):
        r = run_shell_job({"command": 123}, timeout_s=5)
        self.assertIsNotNone(r.error_message)

    def test_stderr_captured(self):
        r = run_shell_job(
            {"command": "echo err >&2"},
            timeout_s=5,
        )
        self.assertIn("err", r.stderr)


if __name__ == "__main__":
    unittest.main()
