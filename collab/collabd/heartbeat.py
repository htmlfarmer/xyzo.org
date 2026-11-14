"""Heartbeat — periodic ping back to xyzo.

Tells the hub "I'm alive, here are my counters". The hub records this in
`collab_nodes.last_heartbeat_at` + `collab_activity` (rate-limited to 1/5min).
"""
from __future__ import annotations

import logging
import time

from .auth import http_post_json
from .config import Config
from .state import State

log = logging.getLogger("collabd.heartbeat")


def send_once(cfg: Config, state: State, *, started_at: float) -> bool:
    """Send one heartbeat. Returns True on success."""
    if not cfg.node_id or not cfg.dashboard_token:
        return False
    url = f"{cfg.hub_url.rstrip('/')}/api/collab/{cfg.node_id}/heartbeat"
    counters = state.snapshot()
    payload = {
        "uptime_s": int(time.time() - started_at),
        "jobs_done": counters.get("jobs_done", 0),
        "jobs_failed": counters.get("jobs_failed", 0),
        "modes_active": cfg.roles,
        "collabd_version": "0.1.0",
    }
    try:
        http_post_json(url, payload, cfg, timeout_s=15)
        return True
    except Exception as e:
        log.warning("heartbeat failed: %s", e)
        return False
