"""`collab` CLI — operator surface for collabd.

Subcommands:
  register    — first-time setup; contacts the hub, gets a node_id + token.
  status      — show local counters + last heartbeat.
  start       — foreground-run the daemon (used by systemd/launchd).
  stop        — tell a running daemon to exit (SIGTERM via pid file).
  restart     — stop + start.
  logs        — tail ~/.collab/logs/collabd.log
  config      — show/edit ~/.collab/config.toml
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

from . import LOG_DIR, STATE_DB_PATH
from .auth import register
from .config import Config

PIDFILE = Path("~/.collab/collabd.pid").expanduser()


def cmd_register(args) -> int:
    cfg = Config.load()
    cfg.name = args.name or ""
    cfg.roles = args.role.split(",") if args.role else ["scripts"]
    if args.hub:
        cfg.hub_url = args.hub
    key_dir = Path("~/.collab").expanduser()
    try:
        res = register(cfg, key_dir)
    except Exception as e:
        print(f"register failed: {e}", file=sys.stderr)
        return 1
    print(json.dumps({
        "node_id": res.node_id,
        "name": res.name,
        "dashboard_url": res.dashboard_url,
        "roles": res.roles,
    }, indent=2))
    return 0


def cmd_status(args) -> int:
    cfg = Config.load()
    if not cfg.node_id:
        print("not registered — run `collab register`")
        return 1
    from .state import State
    state = State()
    counters = state.snapshot()
    pid_file_exists = PIDFILE.exists()
    pid = int(PIDFILE.read_text().strip()) if pid_file_exists else None
    running = False
    if pid:
        try:
            os.kill(pid, 0)
            running = True
        except OSError:
            running = False
    out = {
        "node_id": cfg.node_id,
        "name": cfg.name,
        "hub_url": cfg.hub_url,
        "roles": cfg.roles,
        "collabd_version": "0.1.0",
        "running": running,
        "pid": pid,
        "counters": counters,
        "recent_events": state.recent_events(10),
        "config_path": str(cfg.path),
        "log_path": str(Path(LOG_DIR).expanduser() / "collabd.log"),
    }
    print(json.dumps(out, indent=2))
    return 0


def cmd_start(args) -> int:
    # Foreground (used by systemd). Just calls daemon().
    from .daemon import daemon
    return daemon(register_if_needed=not args.no_register)


def cmd_stop(args) -> int:
    if not PIDFILE.exists():
        print("not running (no pidfile)")
        return 1
    pid = int(PIDFILE.read_text().strip())
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as e:
        print(f"kill failed: {e}")
        return 1
    # Wait up to 10s for graceful shutdown.
    for _ in range(20):
        time.sleep(0.5)
        try:
            os.kill(pid, 0)
        except OSError:
            PIDFILE.unlink(missing_ok=True)
            print("stopped")
            return 0
    print("did not exit within 10s — sending SIGKILL")
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    PIDFILE.unlink(missing_ok=True)
    return 0


def cmd_logs(args) -> int:
    log_path = Path(LOG_DIR).expanduser() / "collabd.log"
    if not log_path.exists():
        print(f"no log at {log_path}")
        return 1
    if args.follow:
        # Simple tail -f implementation.
        with log_path.open() as f:
            f.seek(0, os.SEEK_END)
            while True:
                line = f.readline()
                if not line:
                    time.sleep(0.5)
                    continue
                print(line, end="")
    else:
        print(log_path.read_text())
    return 0


def cmd_config(args) -> int:
    cfg = Config.load()
    if args.show:
        print(json.dumps({k: getattr(cfg, k) for k in cfg.__dataclass_fields__}, indent=2))
    elif args.set:
        key, _, val = args.set.partition("=")
        key, val = key.strip(), val.strip()
        if not hasattr(cfg, key):
            print(f"unknown key: {key}", file=sys.stderr)
            return 1
        cur = getattr(cfg, key)
        if isinstance(cur, bool):
            setattr(cfg, key, val.lower() in ("1", "true", "yes"))
        elif isinstance(cur, int):
            setattr(cfg, key, int(val))
        elif isinstance(cur, list):
            setattr(cfg, key, [v.strip() for v in val.split(",") if v.strip()])
        else:
            setattr(cfg, key, val)
        cfg.save()
        print(f"{key} set")
    else:
        print(f"config at: {cfg.path}")
        print(f"  exists: {cfg.exists()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="collab", description="collabd operator CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("register", help="register this node with xyzo")
    pr.add_argument("--name", help="display name (defaults to hostname)")
    pr.add_argument("--role", help="comma-separated roles (default: scripts)")
    pr.add_argument("--hub", help="hub URL (default: https://xyzo.org)")
    pr.set_defaults(fn=cmd_register)

    ps = sub.add_parser("status", help="show node status + counters")
    ps.set_defaults(fn=cmd_status)

    pst = sub.add_parser("start", help="run the daemon in the foreground")
    pst.add_argument("--no-register", action="store_true", help="don't auto-register on first run")
    pst.set_defaults(fn=cmd_start)

    psp = sub.add_parser("stop", help="stop a running daemon (SIGTERM)")
    psp.set_defaults(fn=cmd_stop)

    pl = sub.add_parser("logs", help="show / tail the daemon log")
    pl.add_argument("-f", "--follow", action="store_true", help="follow the log")
    pl.set_defaults(fn=cmd_logs)

    pc = sub.add_parser("config", help="show or edit config")
    pc.add_argument("--show", action="store_true", help="print full config as JSON")
    pc.add_argument("--set", help='set "key=value" (e.g. poll_interval_s=10)')
    pc.set_defaults(fn=cmd_config)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
