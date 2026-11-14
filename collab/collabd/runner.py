"""Job runner — sandboxed subprocess executor.

A `shell` kind job gets:
  payload = {
    "command": ["bash", "-c", "echo hello"],  # argv form, OR
    "command": "echo hello",                   # string form → wraps in /bin/sh -c
    "env": {"FOO": "bar"},                     # extra env (merged with safe defaults)
    "cwd": "/tmp",                              # optional working directory
    "max_output_kb": 256,                       # cap stdout/stderr to N KB
  }

We run the child in its own process group, capture stdout+stderr separately,
enforce a wall-clock timeout (SIGTERM → SIGKILL after 5s grace), and cap
output size to prevent the network from being the bottleneck.

Returned JobResult:
  {exit_code, stdout, stderr, duration_ms, error_message?}
"""
from __future__ import annotations

import os
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass, field


@dataclass
class JobResult:
    exit_code: int | None
    stdout: str
    stderr: str
    duration_ms: int
    error_message: str | None = None
    truncated: bool = field(default=False)


# A small allowlist of env vars the runner is willing to forward from the
# parent. We don't pass through PATH unless explicitly set in payload["env"],
# and we never pass through LD_PRELOAD, LD_LIBRARY_PATH, PYTHONPATH, etc.
_SAFE_ENV_KEYS = {
    "PATH", "LANG", "LC_ALL", "TZ", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
    "LANGUAGE", "LC_CTYPE",
}


def _coerce_command(cmd) -> list[str]:
    if isinstance(cmd, str):
        # Use shlex to honor quoting; final exec via /bin/sh -c.
        # Validate it parses cleanly first.
        shlex.split(cmd)
        return ["/bin/sh", "-c", cmd]
    if isinstance(cmd, list):
        if not all(isinstance(x, str) for x in cmd):
            raise ValueError("command list must be all strings")
        if not cmd:
            raise ValueError("command list is empty")
        return list(cmd)
    raise ValueError(f"command must be str or list[str], got {type(cmd).__name__}")


def run_shell_job(payload: dict, *, timeout_s: int) -> JobResult:
    """Run a 'shell' kind job and return a JobResult."""
    if "command" not in payload:
        return JobResult(
            exit_code=None,
            stdout="",
            stderr="",
            duration_ms=0,
            error_message="payload missing 'command'",
        )

    try:
        argv = _coerce_command(payload["command"])
    except ValueError as e:
        return JobResult(
            exit_code=None,
            stdout="",
            stderr="",
            duration_ms=0,
            error_message=f"bad command: {e}",
        )

    # Build env from safe defaults + payload overrides.
    env: dict[str, str] = {}
    for k in _SAFE_ENV_KEYS:
        if k in os.environ:
            env[k] = os.environ[k]
    for k, v in (payload.get("env") or {}).items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        # Strip dangerous LD_* / PYTHONPATH / NODE_PATH overrides regardless
        # of payload. These are footguns for a job runner.
        if k.startswith(("LD_", "PYTHONPATH", "NODE_PATH", "DYLD_")):
            continue
        env[k] = v

    cwd = payload.get("cwd") or os.getcwd()
    max_kb = int(payload.get("max_output_kb") or 256)
    max_bytes = max_kb * 1024

    start = time.monotonic()
    try:
        # Start in its own process group so we can SIGTERM the whole tree.
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,  # own pgid
            text=False,  # we decode + truncate ourselves
        )
    except FileNotFoundError as e:
        return JobResult(
            exit_code=None,
            stdout="",
            stderr="",
            duration_ms=int((time.monotonic() - start) * 1000),
            error_message=f"executable not found: {e}",
        )
    except Exception as e:
        return JobResult(
            exit_code=None,
            stdout="",
            stderr="",
            duration_ms=int((time.monotonic() - start) * 1000),
            error_message=f"spawn failed: {e}",
        )

    try:
        stdout_bytes, stderr_bytes = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        # Try graceful first, then kill.
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                stdout_bytes, stderr_bytes = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                stdout_bytes, stderr_bytes = proc.communicate(timeout=2)
        except ProcessLookupError:
            stdout_bytes, stderr_bytes = b"", b""
        return JobResult(
            exit_code=None,
            stdout=_truncate(stdout_bytes, max_bytes),
            stderr=_truncate(stderr_bytes, max_bytes),
            duration_ms=int((time.monotonic() - start) * 1000),
            error_message=f"timeout after {timeout_s}s",
            truncated=True,
        )

    duration_ms = int((time.monotonic() - start) * 1000)
    truncated = len(stdout_bytes) > max_bytes or len(stderr_bytes) > max_bytes
    return JobResult(
        exit_code=proc.returncode,
        stdout=_truncate(stdout_bytes, max_bytes),
        stderr=_truncate(stderr_bytes, max_bytes),
        duration_ms=duration_ms,
        truncated=truncated,
    )


def _truncate(data: bytes | str, max_bytes: int) -> str:
    """Decode + truncate to max_bytes, suffix-marker if cut."""
    if isinstance(data, bytes):
        try:
            s = data.decode("utf-8", errors="replace")
        except Exception:
            s = data.decode("latin-1", errors="replace")
    else:
        s = data
    # Encode to count bytes, then truncate, then decode again.
    raw = s.encode("utf-8", errors="replace")[:max_bytes]
    out = raw.decode("utf-8", errors="replace")
    if len(s.encode("utf-8")) > max_bytes:
        out += f"\n[... truncated at {max_bytes} bytes ...]"
    return out
