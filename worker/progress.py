"""Live discovery status writer.

The auto-discover endpoint spawns the worker as a detached process with
``stdio="ignore"``, so the API has no way to see what the worker is
actually doing. We close that gap by writing a single JSON file at a
shared path (passed in via the ``XYZO_DISCOVERY_STATUS_FILE`` env
var): every step calls ``ProgressWriter.update(...)`` after each unit of
work, the file is rewritten atomically, and ``/api/discovery-status``
just reads it on each poll.

Schema:

  {
    "request_id":   int,
    "step":         str,          // current step id e.g. "init", "cities", "validate"
    "detail":       str,          // short human-readable status line
    "started_at":   float,       // epoch seconds
    "updated_at":   float,       // epoch seconds
    "finished_at":  float|null,
    "progress_pct": float,       // 0-100 estimated completion
    "counters": {
        "articles_fetched":   int,
        "articles_extracted": int,
        "articles_geocoded":  int,
        "sources_added":      int,
        "sources_geocoded":   int,
        "domains_found":      int,
        "feeds_probed":       int,
    },
    "step_timings": { step_id: elapsed_ms },   // only set after step completes
    "log_entries": [                           // structured debug log (max 200)
        { "t": float, "lvl": "info"|"warn"|"error"|"debug", "msg": str, "ctx": dict|null }
    ],
    "recent_articles": [ ... ],  (max 25)
    "recent_sources":  [ ... ],  (max 25)
    "detected_areas":  [ ... ],
    "discovered_cities": [ ... ],
    "searched_sources": [ ... ],
    "found_news":      [ ... ],
    "step_history":    { step_id: detail_str },
  }

Thread-safe so the extraction loop (httpx streaming in a worker
thread) and any future background progress calls don't race the
atomic-rename write.
"""
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("xyzo.progress")

# Log levels in order of severity
LOG_LEVELS = {"debug": 0, "info": 1, "warn": 2, "error": 3}


class ProgressWriter:
    """Atomic, thread-safe JSON status writer.

    Usage:
        pw = ProgressWriter("/tmp/status.json", request_id=42)
        pw.log("info", "Starting city search", {"bbox": [1,2,3,4]})
        pw.update(step="cities", detail="Found 3 cities", counters={"domains_found": 3})
        pw.log("warn", "Nominatim rate limited, retrying")
        pw.finish(step="complete", detail="Done in 45s")
    """

    RECENT_CAP = 25
    LOG_CAP = 200  # Max log entries to keep

    # Step order for progress estimation
    STEP_ORDER = [
        "init",
        "cities",
        "countries",
        "search",
        "discover",
        "validate",
        "add",
        "fetch",
        "auto_categorize",
        "extract",
        "geocode",
        "cluster",
        "complete",
    ]

    def __init__(self, path: str | Path, request_id: int):
        self.path = Path(path)
        self.request_id = request_id
        self._lock = threading.Lock()
        now = time.time()
        self._elapsed_start = now
        self._state: dict[str, Any] = {
            "request_id": request_id,
            "step": "init",
            "detail": "Starting...",
            "started_at": now,
            "updated_at": now,
            "finished_at": None,
            "progress_pct": 0.0,
            "counters": {
                "articles_fetched": 0,
                "articles_extracted": 0,
                "articles_geocoded": 0,
                "sources_added": 0,
                "sources_geocoded": 0,
                "domains_found": 0,
                "feeds_probed": 0,
            },
            "step_timings": {},
            "log_entries": [],
            "recent_articles": [],
            "recent_sources": [],
            "detected_areas": [],
            "discovered_cities": [],
            "searched_sources": [],
            "found_news": [],
            "step_history": {},
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            log.warning("could not mkdir for progress file: %s", exc)
        self._write()

    @classmethod
    def from_env(cls, request_id: int) -> "ProgressWriter | None":
        path = __import__("os").environ.get("XYZO_DISCOVERY_STATUS_FILE")
        if not path:
            return None
        return cls(path, request_id)

    # ── Public API ────────────────────────────────────────────────────────

    def log(
        self,
        level: str = "info",
        message: str = "",
        ctx: dict | None = None,
    ) -> None:
        """Append a structured debug log entry.

        Args:
            level: one of "debug", "info", "warn", "error"
            message: human-readable message
            ctx: optional extra data (displayed in debug panel)
        """
        with self._lock:
            entry = {
                "t": time.time(),
                "lvl": level if level in LOG_LEVELS else "info",
                "msg": str(message)[:500],
                "ctx": ctx,
            }
            self._state["log_entries"].append(entry)
            if len(self._state["log_entries"]) > self.LOG_CAP:
                self._state["log_entries"] = self._state["log_entries"][-self.LOG_CAP :]
            self._state["updated_at"] = time.time()
            self._write()

    def update(
        self,
        *,
        step: str | None = None,
        detail: str | None = None,
        counters: dict | None = None,
        recent_article: dict | None = None,
        recent_source: dict | None = None,
        detected_area: dict | None = None,
        discovered_city: dict | None = None,
        searched_source: dict | None = None,
        found_news_item: dict | None = None,
        step_timings: dict | None = None,
        finished: bool = False,
    ) -> None:
        with self._lock:
            now = time.time()
            if step is not None:
                prev_step = self._state.get("step")
                prev_detail = self._state.get("detail")
                if prev_step and prev_detail and prev_step != step:
                    self._state.setdefault("step_history", {})[prev_step] = prev_detail
                self._state["step"] = step
                # Estimate progress: steps before current are done
                try:
                    idx = self.STEP_ORDER.index(step)
                    self._state["progress_pct"] = round((idx / len(self.STEP_ORDER)) * 100, 1)
                except ValueError:
                    pass
            if detail is not None:
                self._state["detail"] = detail
                if step:
                    self._state.setdefault("step_history", {})[step] = detail
            if counters:
                for k, v in counters.items():
                    if k in self._state["counters"]:
                        try:
                            self._state["counters"][k] = int(v)
                        except (TypeError, ValueError):
                            pass
            if step_timings:
                self._state["step_timings"].update(step_timings)
            if recent_article is not None:
                self._prepend_capped("recent_articles", recent_article)
            if recent_source is not None:
                self._prepend_capped("recent_sources", recent_source)
            if detected_area is not None:
                self._prepend_capped("detected_areas", detected_area)
            if discovered_city is not None:
                self._prepend_capped("discovered_cities", discovered_city)
            if searched_source is not None:
                self._prepend_capped("searched_sources", searched_source)
            if found_news_item is not None:
                self._prepend_capped("found_news", found_news_item)
            self._state["updated_at"] = now
            if finished:
                self._state["finished_at"] = now
                self._state["progress_pct"] = 100.0
            self._write()

    def finish(self, step: str = "complete", detail: str = "Discovery finished") -> None:
        self.update(step=step, detail=detail, finished=True)

    # ── internals ───────────────────────────────────────────────────────

    def _prepend_capped(self, key: str, entry: dict) -> None:
        items = self._state[key]
        items.insert(0, entry)
        if len(items) > self.RECENT_CAP:
            del items[self.RECENT_CAP :]

    def _write(self) -> None:
        try:
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._state, f, default=str)
            tmp.replace(self.path)
        except OSError as exc:
            log.debug("progress file write skipped: %s", exc)


def read_status(path: str | Path) -> dict | None:
    """Read the latest status file. Returns None if the file is missing
    or unreadable — callers should fall back to the elapsed-time
    staircase for that case."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
