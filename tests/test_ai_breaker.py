"""Unit tests for api/src/ai-breaker.ts — uses the bun-built JavaScript
runtime to load the module and exercise the CircuitBreaker class.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# Path to the API source dir; the breaker is plain TypeScript so bun
# can run it directly without compilation.
API_SRC = Path(__file__).resolve().parent.parent / "api" / "src"


def _run_js(script: str) -> str:
    """Run a TypeScript snippet via bun from the API src dir.

    Bun doesn't have an `eval` subcommand, so we write a temp file
    in the API src dir, run it with `bun run`, then clean up.

    Strips out the breaker's own console.log lines ("[ai-breaker] ...")
    so test assertions can match on the actual test output.
    """
    full = f"""import {{ aiBreaker, withBreaker }} from "./ai-breaker.ts";
{script}
"""
    tmp_path = API_SRC / "_test_breaker.ts"
    tmp_path.write_text(full)
    try:
        proc = subprocess.run(
            ["bun", "run", str(tmp_path)],
            cwd=str(API_SRC),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"bun failed: {proc.stderr}")
        # Filter out the breaker's own log lines and return clean stdout.
        lines = [
            ln for ln in proc.stdout.splitlines()
            if not ln.startswith("[ai-breaker]")
        ]
        return "\n".join(lines).strip()
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def _run_js_with_breaker_reset(script: str) -> str:
    """Run a snippet after resetting the breaker state."""
    return _run_js("""
aiBreaker.forceClose();
""" + script)


class TestCircuitBreaker:
    def setup_method(self):
        # Reset state before each test by force-closing.
        _run_js_with_breaker_reset("")

    def test_allows_initially(self):
        out = _run_js("console.log(aiBreaker.shouldAllow())")
        assert out == "true"

    def test_opens_after_threshold(self):
        out = _run_js("""
for (let i = 0; i < 3; i++) aiBreaker.recordFailure("test");
console.log(aiBreaker.shouldAllow());
""")
        assert out == "false"

    def test_success_closes_breaker(self):
        out = _run_js("""
for (let i = 0; i < 3; i++) aiBreaker.recordFailure("test");
aiBreaker.recordSuccess();
console.log(aiBreaker.shouldAllow());
""")
        assert out == "true"

    def test_snapshot_shape(self):
        out = _run_js("console.log(JSON.stringify(aiBreaker.snapshot()))")
        snap = json.loads(out)
        assert "open" in snap
        assert "open_for_ms" in snap
        assert "recent_failures" in snap
        assert "fail_threshold" in snap
        assert snap["fail_threshold"] == 3

    def test_withBreaker_propagates_success(self):
        out = _run_js("""
const r = await withBreaker("test", async () => 42);
console.log(String(r));
""")
        assert out == "42"

    def test_withBreaker_records_failure(self):
        out = _run_js("""
try {
  await withBreaker("test", async () => { throw new Error("boom"); });
} catch (e) {
  // expected
}
const snap = aiBreaker.snapshot();
console.log(String(snap.recent_failures >= 1));
""")
        assert out == "true"

    def test_short_circuit_count(self):
        # Trip the breaker first, then a call should short-circuit.
        out = _run_js("""
for (let i = 0; i < 3; i++) aiBreaker.recordFailure("test");
const r = await withBreaker("test", async () => "should-not-run");
const snap = aiBreaker.snapshot();
// JSON.stringify drops undefined keys, so we serialize result
// explicitly with a sentinel value if undefined.
const resultSerialized = r === undefined ? "UNDEFINED" : String(r);
console.log(JSON.stringify({ result: resultSerialized, shorts: snap.total_short_circuits }));
""")
        d = json.loads(out)
        assert d["result"] == "UNDEFINED"
        assert d["shorts"] >= 1

    def test_force_close_resets_state(self):
        out = _run_js("""
for (let i = 0; i < 3; i++) aiBreaker.recordFailure("test");
aiBreaker.forceClose();
console.log(aiBreaker.shouldAllow());
""")
        assert out == "true"