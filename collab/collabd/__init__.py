"""collabd — collaborator daemon.

Runs on a collaborator's computer. Pulls jobs from xyzo.org's collab queue,
runs them in sandboxed subprocesses, reports results back. Future modes
(gateway, model_serve, content, discovery, self_improve) plug into the
same daemon skeleton.

Stdlib-only by design — no pip install required at runtime.
"""

__version__ = "0.1.0"
DEFAULT_HUB_URL = "https://xyzo.org"
CONFIG_PATH = "~/.collab/config.toml"
STATE_DB_PATH = "~/.collab/state.sqlite3"
LOG_DIR = "~/.collab/logs"
