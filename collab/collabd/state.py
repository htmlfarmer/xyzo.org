"""Local persistent state for collabd.

Tracks jobs_done, jobs_failed, total uptime, last error. Backed by sqlite3
so the daemon can restart without losing counters (used by heartbeats).
"""
from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from . import STATE_DB_PATH


_SCHEMA = """
CREATE TABLE IF NOT EXISTS counters (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts DESC);
CREATE INDEX IF NOT EXISTS events_kind_idx ON events(kind, ts DESC);
"""


class State:
    def __init__(self, path: Path | None = None):
        self.path = Path(os.path.expanduser(path or STATE_DB_PATH))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _init_schema(self) -> None:
        with self._conn() as c:
            c.executescript(_SCHEMA)
            c.commit()

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def incr(self, key: str, by: int = 1) -> int:
        with self._conn() as c:
            c.execute(
                "INSERT INTO counters (k, v) VALUES (?, ?) "
                "ON CONFLICT (k) DO UPDATE SET v = v + excluded.v",
                (key, by),
            )
            c.commit()
            row = c.execute("SELECT v FROM counters WHERE k = ?", (key,)).fetchone()
            return int(row["v"]) if row else 0

    def get(self, key: str, default: int = 0) -> int:
        with self._conn() as c:
            row = c.execute("SELECT v FROM counters WHERE k = ?", (key,)).fetchone()
            return int(row["v"]) if row else default

    def snapshot(self) -> dict[str, int]:
        """Return all counter values as a dict (for heartbeat payload)."""
        with self._conn() as c:
            rows = c.execute("SELECT k, v FROM counters").fetchall()
            return {r["k"]: int(r["v"]) for r in rows}

    def log_event(self, kind: str, detail: str = "") -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)",
                (time.time(), kind, detail[:2000]),
            )
            c.commit()

    def recent_events(self, limit: int = 20) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT ts, kind, detail FROM events ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [{"ts": r["ts"], "kind": r["kind"], "detail": r["detail"]} for r in rows]
