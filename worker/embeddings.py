"""embeddings — local sentence-transformers for semantic event dedup.

Lazy-loads all-MiniLM-L6-v2 (384-dim, ~80MB) on first use. The model
is cached at module level so subsequent calls in the same Python
subprocess are fast (~30ms for a batch of 64 events).

Designed to be defensive: every function returns None on failure
rather than raising, so the crawler can never crash on embedding issues.
"""
from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger("xyzo.embeddings")

_MODEL = None
_AVAILABLE: bool | None = None


def _is_disabled() -> bool:
    return os.environ.get("XYZO_DISABLE_EMBEDDINGS", "").lower() in ("1", "true", "yes")


def set_available(value: bool) -> None:
    """Override availability check. Used in tests + during graceful degradation."""
    global _AVAILABLE
    _AVAILABLE = value


def is_available() -> bool:
    """Return True if the embedding model can be loaded."""
    if _AVAILABLE is not None:
        return _AVAILABLE
    if _is_disabled():
        return False
    try:
        get_model()
        return True
    except Exception as e:
        log.warning("sentence-transformers unavailable: %s", e)
        return False


def get_model():
    """Lazy-load and cache the model. Returns the SentenceTransformer."""
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    return _MODEL


def event_to_text(event: dict[str, Any]) -> str:
    """Compose canonical event text for embedding + display search."""
    description = (event.get("description") or "").split(".")[0][:200]
    parts = [
        event.get("title") or "",
        event.get("venue_name") or "",
        event.get("city") or "",
        event.get("country_code") or "",
        description,
        " ".join(event.get("categories") or []),
    ]
    return " | ".join(p for p in parts if p).strip()


def encode_event(event: dict[str, Any]) -> list[float] | None:
    """Encode a single event. Returns a 384-dim list, or None on failure."""
    if not is_available():
        return None
    try:
        text = event_to_text(event)
        if not text:
            return None
        vec = get_model().encode(text, normalize_embeddings=True)
        return vec.tolist()
    except Exception as e:
        log.warning("encode_event failed: %s", e)
        set_available(False)
        return None


def encode_events_batch(events: list[dict[str, Any]]) -> list[list[float] | None]:
    """Encode many events in one call. Returns list aligned with input."""
    if not is_available() or not events:
        return [None] * len(events)
    try:
        texts = [event_to_text(e) for e in events]
        texts = [t if t else " " for t in texts]   # model needs non-empty
        vecs = get_model().encode(texts, normalize_embeddings=True,
                                   batch_size=64, show_progress_bar=False)
        return [v.tolist() for v in vecs]
    except Exception as e:
        log.warning("encode_events_batch failed: %s", e)
        return [None] * len(events)
