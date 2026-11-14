"""Entry point: `python -m collabd ...` or `collab ...`.

Dispatch:
  - `collabd start`        → daemon.daemon()
  - `collabd register`     → cli.cmd_register
  - `collabd status`       → cli.cmd_status
  - `collabd stop`         → cli.cmd_stop
  - `collabd logs`         → cli.cmd_logs
  - `collabd config ...`   → cli.cmd_config
  - `collabd` (no args)    → daemon.daemon() (foreground)

We always write the pidfile in daemon mode so `collab stop` can find us.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

PIDFILE = Path("~/.collab/collabd.pid").expanduser()


def _maybe_write_pidfile() -> None:
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)
    PIDFILE.write_text(str(os.getpid()))


def main() -> int:
    # No args → run as daemon (foreground).
    if len(sys.argv) <= 1 or sys.argv[1] == "start":
        _maybe_write_pidfile()
        from .daemon import daemon
        try:
            return daemon()
        finally:
            try:
                PIDFILE.unlink()
            except FileNotFoundError:
                pass
    # Otherwise, dispatch to the CLI.
    from .cli import main as cli_main
    return cli_main(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
