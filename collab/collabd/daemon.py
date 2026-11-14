"""Main daemon — orchestrates modes + heartbeats.

A `collabd` process has three threads:
  1. Mode loop(s) — one per role in cfg.roles. PR-1 only runs `scripts`.
  2. Heartbeat thread — pings xyzo every heartbeat_interval_s.
  3. Main thread — handles signals, joins the others.

The daemon exits cleanly when SIGTERM/SIGINT arrives (or when `collab stop`
runs). On Windows, Ctrl-C is handled via KeyboardInterrupt.
"""
from __future__ import annotations

import logging
import signal
import threading
import time

from . import LOG_DIR
from .auth import register, detect_os, detect_arch
from .config import Config, first_run_check
from .heartbeat import send_once
from .modes import scripts
from .state import State

log = logging.getLogger("collabd")


def _setup_logging(level: str) -> None:
    import os
    from pathlib import Path
    log_dir = Path(os.path.expanduser(LOG_DIR))
    log_dir.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger("collabd")
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # Avoid double-handlers if daemon() is called twice in a test.
    if root.handlers:
        return

    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")

    # File handler — append mode so we keep history across restarts.
    fh = logging.FileHandler(log_dir / "collabd.log")
    fh.setFormatter(fmt)
    root.addHandler(fh)

    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(sh)


def daemon(*, register_if_needed: bool = True) -> int:
    """Run the daemon. Returns exit code."""
    cfg = Config.load()
    _setup_logging(cfg.log_level)
    log.info("collabd starting (version 0.1.0, hub=%s)", cfg.hub_url)

    if first_run_check():
        if not register_if_needed:
            log.error("no config — run `collab register` first")
            return 2
        log.info("no config — running first-time registration")
        from pathlib import Path
        key_dir = Path.home() / ".collab"
        try:
            res = register(cfg, key_dir)
        except Exception as e:
            log.error("registration failed: %s", e)
            return 3
        log.info("registered as node %s", res.node_id)

    state = State()
    started_at = time.time()
    stop_event = threading.Event()

    # Signal handlers — both Unix and Windows.
    def _stop(signum, frame):  # noqa: ARG001
        log.info("received signal %s — shutting down", signum)
        stop_event.set()
    try:
        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
    except (ValueError, AttributeError):
        pass  # Windows or non-main thread

    # Spin up mode threads (one per role).
    mode_threads: list[tuple[str, threading.Thread]] = []
    for role in cfg.roles:
        if role == "scripts":
            t = threading.Thread(
                target=scripts.loop,
                args=(cfg, state),
                kwargs={"stop_event": stop_event},
                name="mode-scripts",
                daemon=True,
            )
        else:
            log.warning("role %r not implemented in PR-1 — skipping", role)
            continue
        t.start()
        mode_threads.append((role, t))

    # Heartbeat thread.
    def _heartbeat_loop():
        while not stop_event.is_set():
            send_once(cfg, state, started_at=started_at)
            stop_event.wait(cfg.heartbeat_interval_s)

    hb = threading.Thread(target=_heartbeat_loop, name="heartbeat", daemon=True)
    hb.start()

    log.info(
        "collabd running (node=%s, roles=%s, poll=%ss, hb=%ss)",
        cfg.node_id, cfg.roles, cfg.poll_interval_s, cfg.heartbeat_interval_s,
    )

    try:
        # Main thread waits for stop.
        while not stop_event.is_set():
            stop_event.wait(1.0)
            # If a mode thread died unexpectedly, log it but keep going.
            for role, t in mode_threads:
                if not t.is_alive():
                    log.error("mode thread %s died — exiting daemon", role)
                    stop_event.set()
    finally:
        log.info("stopping...")
        stop_event.set()
        for role, t in mode_threads:
            t.join(timeout=5)
        hb.join(timeout=5)
        # Final heartbeat so the dashboard sees the goodbye.
        try:
            send_once(cfg, state, started_at=started_at)
        except Exception:
            pass
        log.info("collabd stopped")

    return 0
