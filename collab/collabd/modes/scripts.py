"""scripts mode — pull jobs from xyzo, run them, report results.

This is the only mode in PR-1. The loop:
  1. GET /api/collab/jobs → list of queued jobs (priority-sorted).
  2. For the first job: POST /api/collab/jobs/<id>/claim.
  3. Run it via runner.run_shell_job.
  4. POST /api/collab/jobs/<id>/result with stdout/stderr/exit/duration.
  5. Sleep poll_interval_s and repeat.

Errors are caught at each step and logged locally. A persistent network
failure doesn't kill the daemon — we just back off and retry.
"""
from __future__ import annotations

import logging
import threading
import time

from ..auth import http_get_json, http_post_json
from ..config import Config
from ..runner import JobResult, run_shell_job
from ..state import State

log = logging.getLogger("collabd.scripts")


def _list_jobs(cfg: Config) -> list[dict]:
    url = f"{cfg.hub_url.rstrip('/')}/api/collab/jobs?limit=5"
    body = http_get_json(url, timeout_s=15)
    return body.get("jobs") or []


def _claim(cfg: Config, job_id: int) -> dict | None:
    """Returns the claimed job dict, or None if it was already taken."""
    url = (
        f"{cfg.hub_url.rstrip('/')}/api/collab/jobs/{job_id}/claim"
        f"?node_id={cfg.node_id}"
    )
    try:
        body = http_post_json(url, {}, cfg, timeout_s=15)
        return body.get("job")
    except RuntimeError as e:
        if "409" in str(e):
            return None
        raise


def _submit_result(cfg: Config, job_id: int, result: JobResult, *, node_id: str) -> bool:
    url = f"{cfg.hub_url.rstrip('/')}/api/collab/jobs/{job_id}/result"
    payload = {
        "node_id": node_id,
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "duration_ms": result.duration_ms,
        "error_message": result.error_message,
    }
    try:
        http_post_json(url, payload, cfg, timeout_s=30)
        return True
    except Exception as e:
        log.warning("submit_result failed for job %s: %s", job_id, e)
        return False


def _process_one(cfg: Config, state: State, job: dict) -> None:
    """Run one job end-to-end."""
    job_id = int(job["id"])
    kind = job.get("kind", "shell")
    payload = job.get("payload") or {}
    timeout_s = int(job.get("timeout_seconds") or 300)

    log.info("running job %s (kind=%s, timeout=%ss)", job_id, kind, timeout_s)
    state.log_event("job_start", f"job_id={job_id} kind={kind}")

    if kind == "shell":
        result = run_shell_job(payload, timeout_s=timeout_s)
    else:
        # Unknown kind — fail loudly so the operator sees it on the dashboard.
        result = JobResult(
            exit_code=None,
            stdout="",
            stderr="",
            duration_ms=0,
            error_message=f"unsupported kind: {kind}",
        )

    ok = result.exit_code == 0 and not result.error_message
    state.incr("jobs_done" if ok else "jobs_failed")
    state.log_event(
        "job_done" if ok else "job_failed",
        f"job_id={job_id} exit={result.exit_code} duration_ms={result.duration_ms}",
    )

    submitted = _submit_result(cfg, job_id, result, node_id=cfg.node_id)
    if not submitted:
        # We already incremented the local counter; the result is lost.
        # PR-2 will add a retry queue for this case.
        log.warning("job %s result not delivered (network error)", job_id)


def loop(cfg: Config, state: State, *, stop_event: threading.Event) -> None:
    """Main scripts-mode loop. Returns when stop_event is set."""
    log.info("scripts mode: polling every %ss", cfg.poll_interval_s)
    consecutive_errors = 0
    while not stop_event.is_set():
        try:
            jobs = _list_jobs(cfg)
            consecutive_errors = 0
        except Exception as e:
            consecutive_errors += 1
            backoff = min(60, cfg.poll_interval_s * (2 ** min(consecutive_errors, 4)))
            log.warning("list_jobs failed (%s); backing off %ss", e, backoff)
            stop_event.wait(backoff)
            continue

        if not jobs:
            stop_event.wait(cfg.poll_interval_s)
            continue

        # Try to claim the first job. If someone else got it, try the next.
        for job in jobs:
            try:
                claimed = _claim(cfg, int(job["id"]))
            except Exception as e:
                log.warning("claim failed for job %s: %s", job.get("id"), e)
                continue
            if claimed:
                _process_one(cfg, state, claimed)
                break  # one job per loop tick — keeps heartbeats timely
        else:
            # None claimed; pause briefly before retrying.
            stop_event.wait(min(cfg.poll_interval_s, 2))
            continue

        stop_event.wait(1)  # small breather between jobs
