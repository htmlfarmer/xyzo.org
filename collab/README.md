# collab — collaborator network

A `curl | bash` onboarding that turns any laptop or server into a worker
for **xyzo.org**, **hivv.org**, and **blnq.org**.

PR-1 ships **one mode**: `scripts` — pull jobs from a queue, run them
in a sandboxed subprocess, report results.

PR-2/3/4 will add `gateway`, `model_serve`, `content`, `discovery`, and
`self_improve`. See the [roadmap](#roadmap) below.

## Quick start

```bash
curl -sSL https://xyzo.org/install-collab.sh | bash
```

That's it. The script will:

1. Detect your OS (macOS, Linux, WSL).
2. Install python3 (>= 3.9), git, and the `cryptography` package if missing.
3. Clone this repo into `~/collab/`.
4. Generate a 2048-bit RSA keypair in `~/.collab/`.
5. Register the public key with `xyzo.org/api/collab/register`.
6. Install a `systemd --user` unit (Linux) or `launchd` plist (macOS).
7. Start the daemon.
8. Print your `node_id` and dashboard URL.

## What you get

| Path | Purpose |
|------|---------|
| `~/collab/` | the daemon source (cloned from this repo) |
| `~/.collab/config.toml` | hub URL, node_id, dashboard_token (mode 0600) |
| `~/.collab/node.key` | private key (mode 0600) — never sent |
| `~/.collab/state.sqlite3` | local counters (jobs_done, jobs_failed, events) |
| `~/.collab/logs/collabd.log` | daemon log (rotated externally) |
| `~/.local/bin/collab` | CLI symlink |

## CLI

```bash
collab status    # show node status, counters, recent events
collab logs -f   # tail the log
collab stop      # stop the daemon (SIGTERM)
collab config --set poll_interval_s=10   # tune
collab config --show
collab register  # re-register (won't change your existing node_id)
```

## How the daemon works

```
┌─────────────────────────────────────────────────────────────┐
│  collabd                                                     │
│                                                              │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│   │ mode:scripts │    │   heartbeat  │    │  local state │ │
│   │              │    │              │    │  (sqlite3)   │ │
│   │ GET /jobs    │    │ POST /heart- │    │              │ │
│   │ POST /claim  │    │ beat every   │    │ counters +   │ │
│   │ run subprocess│   │ 30s          │    │ event log    │ │
│   │ POST /result │    │              │    │              │ │
│   └──────────────┘    └──────────────┘    └──────────────┘ │
│                                                              │
│           xyzo.org ◄──── HTTPS ────► collabd                │
└─────────────────────────────────────────────────────────────┘
```

The daemon has three threads:

1. **mode:scripts** — polls `GET /api/collab/jobs`, claims one via `POST /api/collab/jobs/<id>/claim`, runs the shell payload in a sandboxed subprocess, submits the result via `POST /api/collab/jobs/<id>/result`.
2. **heartbeat** — every 30s, POSTs counters + uptime to `/api/collab/<node_id>/heartbeat`.
3. **main** — listens for SIGTERM/SIGINT, joins the threads, sends a final heartbeat.

All HTTP is over TLS to `xyzo.org` (configurable via `--hub`). Auth is
bearer token (issued at register-time). Future versions may sign
requests with the RSA key.

## Sandboxing notes

The `scripts` mode runner:

- Runs in its own process group (`start_new_session=True`) so we can SIGTERM the whole tree on timeout.
- Wall-clock timeout enforced; SIGTERM at `timeout_s`, SIGKILL 5s later.
- Stdout/stderr captured separately, capped at 256 KB each (configurable via `max_output_kb`).
- Strips `LD_*`, `PYTHONPATH`, `NODE_PATH`, `DYLD_*` from the child's env even if the payload sets them.
- Forwards only a small allowlist of env vars from the parent (`PATH`, `LANG`, `TZ`, …).

This is *not* a full sandbox. PR-2 will add a `--mode=scripts:strict` flag
that uses OS-level isolation (Landlock on Linux, sandbox-exec on macOS)
for jobs that say so in their payload.

## Adding a new mode

Each mode is a Python module under `collabd/modes/`. Skeleton:

```python
# collabd/modes/my_mode.py
import logging
import threading

log = logging.getLogger("collabd.my_mode")

def loop(cfg, state, *, stop_event):
    while not stop_event.is_set():
        # do work, respecting stop_event.wait(N) for sleep
        ...
```

Then register it in `collabd/daemon.py`'s role-dispatch loop, and add the
role name to the `RegisterSchema.roles` enum in `api/src/routes/collab.ts`.

## Roadmap

| PR | What | Status |
|----|------|--------|
| 1 | scripts mode + register API + dashboard | **shipped** |
| 2 | gateway (hivv SDK install) + model_serve (Ollama/LM Studio registration) | planned |
| 3 | content mode (blnq CLI — submit tools, vote, propose edits) | planned |
| 4 | discovery (HN/GitHub/arXiv scan) + self_improve (nightly auto-update) | planned |

## Source layout

```
collab/
├── README.md                  this file
├── install-collab.sh          curl|bash entry point
├── collab                     CLI wrapper (symlinked to ~/.local/bin)
├── collabd/
│   ├── __init__.py            version + default paths
│   ├── __main__.py            `python -m collabd ...` entry
│   ├── cli.py                 `collab` subcommands (register/status/start/stop/logs/config)
│   ├── config.py              ~/.collab/config.toml loader
│   ├── auth.py                RSA keypair + register()
│   ├── state.py               local sqlite (counters + events)
│   ├── runner.py              sandboxed subprocess executor
│   ├── heartbeat.py           periodic ping
│   ├── daemon.py              orchestrator (signals + threads)
│   └── modes/
│       ├── __init__.py
│       └── scripts.py         the only mode in PR-1
└── tests/
    ├── test_runner.py
    └── test_state.py
```

The xyzo.org side of this lives at:

```
api/src/routes/collab.ts              HTTP API
api/migrations/2026-09-16-collab.sql  schema
api/tests/collab.test.ts              API tests
public_html/install-collab.sh         served copy of the bootstrap
public_html/collab/                   public dashboards
```
