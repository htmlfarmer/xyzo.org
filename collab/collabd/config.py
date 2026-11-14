"""Config loader for collabd.

Reads ~/.collab/config.toml. Format is intentionally minimal:

    hub_url = "https://xyzo.org"
    node_id = "abc234def567"  # assigned at register-time
    dashboard_token = "..."   # assigned at register-time
    name = "asher's macbook"
    roles = ["scripts"]
    poll_interval_s = 5
    heartbeat_interval_s = 30

We don't depend on `tomllib` (3.11+ only). A 30-line hand-rolled parser
handles the limited grammar we need — keeps us compatible with Python 3.9+.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path

from . import CONFIG_PATH, DEFAULT_HUB_URL

# Matches: key = "value"   OR   key = 'value'   OR   key = [...]   OR   key = number
_LINE_RE = re.compile(
    r"^\s*(?P<key>[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"
    r"(?P<value>\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|[0-9]+(?:\.[0-9]+)?|true|false|null)"
    r"\s*(?:#.*)?$"
)


@dataclass
class Config:
    hub_url: str = DEFAULT_HUB_URL
    node_id: str = ""
    dashboard_token: str = ""
    name: str = ""
    roles: list[str] = field(default_factory=lambda: ["scripts"])
    poll_interval_s: int = 5
    heartbeat_interval_s: int = 30
    log_level: str = "INFO"
    auto_update: bool = False

    @property
    def path(self) -> Path:
        return Path(os.path.expanduser(CONFIG_PATH))

    def exists(self) -> bool:
        return self.path.exists()

    def save(self) -> None:
        """Persist config to disk (chmod 600 because of the token)."""
        p = self.path
        p.parent.mkdir(parents=True, exist_ok=True)
        lines = ["# collabd config — managed by collabd, do not hand-edit\n"]
        for k, v in asdict(self).items():
            if isinstance(v, list):
                rendered = "[" + ", ".join(f'"{x}"' for x in v) + "]"
            elif isinstance(v, bool):
                rendered = "true" if v else "false"
            elif isinstance(v, (int, float)):
                rendered = str(v)
            else:
                # string
                rendered = f'"{v}"'
            lines.append(f"{k} = {rendered}\n")
        p.write_text("".join(lines))
        try:
            p.chmod(0o600)
        except Exception:
            pass

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        cfg_path = Path(os.path.expanduser(path or CONFIG_PATH))
        if not cfg_path.exists():
            return cls()
        text = cfg_path.read_text()
        values: dict = {}
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            m = _LINE_RE.match(line)
            if not m:
                continue
            key = m.group("key")
            raw_val = m.group("value").strip()
            values[key] = _parse_value(raw_val)
        # Only pass known fields.
        valid_keys = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in values.items() if k in valid_keys}
        return cls(**filtered)


def _parse_value(s: str):
    """Hand-rolled value parser — covers our limited grammar."""
    if s.startswith('"') and s.endswith('"'):
        return s[1:-1].encode().decode("unicode_escape")
    if s.startswith("'") and s.endswith("'"):
        return s[1:-1].encode().decode("unicode_escape")
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        # Split on commas at top level (no nested brackets).
        parts = [p.strip() for p in re.split(r",\s*", inner) if p.strip()]
        out = []
        for p in parts:
            if p.startswith('"') and p.endswith('"'):
                out.append(p[1:-1])
            elif p.startswith("'") and p.endswith("'"):
                out.append(p[1:-1])
            else:
                out.append(p)
        return out
    if s == "true":
        return True
    if s == "false":
        return False
    if s == "null":
        return None
    if re.match(r"^-?\d+$", s):
        return int(s)
    if re.match(r"^-?\d+\.\d+$", s):
        return float(s)
    return s


def first_run_check() -> bool:
    """Returns True if no config exists yet (caller should run register flow)."""
    return not Config.load().exists() or not Config.load().node_id
