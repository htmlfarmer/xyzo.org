"""
worker/log_service_event.py — record a service restart/deployment event to the DB.

Usage:
    python -m worker.log_service_event --service xyzo-api --type restart --reason "Added 73 news sources"
    python -m worker.log_service_event --service xyzo-fast-fetcher --type restart --reason "Config change"
    python -m worker.log_service_event --service xyzo-api --type source_sync --reason "feeds.json sync" --files worker/feeds.json

This is called by:
  - The API server at startup (src/server.ts calls it via subprocess)
  - The worker at startup
  - Humans doing manual deployments

Environment:
  XYZO_DB_DSN   — Postgres connection string (required)
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone


def git(args: list[str], cwd: str) -> str | None:
    """Run a git command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip()
    except Exception:
        return None


def find_repo_root(start: str = __file__) -> str:
    """Walk up from start looking for .git/ directory."""
    import os as _os
    dir_path = os.path.dirname(os.path.abspath(start))
    for _ in range(8):
        if os.path.isdir(os.path.join(dir_path, ".git")):
            return dir_path
        parent = os.path.dirname(dir_path)
        if parent == dir_path:
            break
        dir_path = parent
    return os.path.dirname(os.path.abspath(start))


def get_git_info() -> dict:
    """Collect git SHA, branch, and last commit message."""
    root = find_repo_root()
    sha = git(["rev-parse", "HEAD"], root)
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    message = git(["log", "-1", "--pretty=%s"], root)
    return {
        "git_sha_after": sha,
        "git_branch": branch,
        "git_message": message,
    }


def get_changed_files(since: str | None = None) -> list[str]:
    """Return list of files changed since the last commit (or since `since` iso timestamp)."""
    root = find_repo_root()
    if since:
        output = git(["diff", "--name-only", f"{since}..HEAD"], root)
    else:
        output = git(["diff", "--name-only", "HEAD~1", "HEAD"], root)
    if not output:
        return []
    return [f.strip() for f in output.splitlines() if f.strip()]


def log_service_event(
    service_name: str,
    event_type: str,
    reason: str | None = None,
    changed_files: list[str] | None = None,
    details: dict | None = None,
    created_by: str = "system",
) -> dict:
    """
    Insert a service_event row into the DB.

    Returns the inserted row as a dict.
    """
    from worker.db import connect

    git_info = get_git_info()
    files = changed_files or []
    detail_payload = (details or {}) | git_info

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO service_events (
                    service_name,
                    event_type,
                    git_sha_after,
                    git_branch,
                    git_message,
                    reason,
                    changed_files,
                    details,
                    created_by
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, service_name, event_type, triggered_at, reason
                """,
                [
                    service_name,
                    event_type,
                    git_info.get("git_sha_after"),
                    git_info.get("git_branch"),
                    git_info.get("git_message"),
                    reason,
                    files if files else None,
                    json.dumps(detail_payload) if detail_payload else None,
                    created_by,
                ],
            )
            row = cur.fetchone()
            conn.commit()
            return dict(row) if row else {}


def main():
    parser = argparse.ArgumentParser(
        description="Log a service restart or deployment event to the DB."
    )
    parser.add_argument(
        "--service",
        required=True,
        help="Service name, e.g. xyzo-api, xyzo-fast-fetcher",
    )
    parser.add_argument(
        "--type",
        required=True,
        choices=["restart", "deploy", "config_change", "source_sync"],
        dest="event_type",
        help="Type of event",
    )
    parser.add_argument("--reason", help="Human-readable reason for the event")
    parser.add_argument(
        "--files",
        nargs="*",
        help="List of files changed (auto-detected if not provided)",
    )
    parser.add_argument(
        "--since",
        help="ISO timestamp to diff from (for auto-detecting changed files)",
    )
    parser.add_argument(
        "--created-by",
        default="system",
        help="Who/what triggered the event (default: system)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be logged without writing to DB",
    )
    parser.add_argument(
        "--skip-git",
        action="store_true",
        help="Skip git info collection",
    )

    args = parser.parse_args()

    changed_files = args.files
    if not changed_files and not args.skip_git:
        changed_files = get_changed_files(since=args.since)

    details = {}
    if not args.skip_git:
        details = get_git_info()

    payload = {
        "service_name": args.service,
        "event_type": args.event_type,
        "reason": args.reason,
        "changed_files": changed_files,
        "details": details,
        "created_by": args.created_by,
    }

    print(f"[log_service_event] Payload: {json.dumps(payload, indent=2, default=str)}")

    if args.dry_run:
        print("[log_service_event] Dry run — not writing to DB")
        return

    row = log_service_event(**payload)
    print(f"[log_service_event] Logged event id={row.get('id')} at {row.get('triggered_at')}")


if __name__ == "__main__":
    main()
