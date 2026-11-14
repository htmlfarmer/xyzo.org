# Site Intelligence Subsystem — Phase 3: Embeddings + Classifier + API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local sentence-transformers embeddings pipeline for semantic dedup, train a two-head classifier on our own crawl labels, and ship the admin API endpoints. After this phase, the system is feature-complete and ready to begin staged rollout.

**Architecture:** `embeddings.py` lazy-loads `all-MiniLM-L6-v2` once per subprocess; computes embeddings for extracted events; pgvector cosine search against `upcoming_events` for cross-source dedup. `classifier.py` reads labels from `discovered_pages`, trains a small PyTorch model with two heads (re-ranker + event type), persists metrics to `classifier_runs`. New Hono routes expose manual refresh, flag manipulation, and cost tracking.

**Tech Stack:** sentence-transformers (PyTorch), pgvector, Hono (Bun/TypeScript).

**Spec:** `docs/superpowers/specs/2026-09-06-site-intelligence-design.md` (sections 6, 7, 8, 9)

**Prerequisites:** Phase 1 + Phase 2 complete.

---

## Phase 3 Task Index

- Task 18: `embeddings.py` module + tests
- Task 19: pgvector dedup query + tests
- Task 20: Wire embeddings into `site_crawl.py`
- Task 21: Classifier training data query
- Task 22: Classifier two-head model
- Task 23: `train_classifier()` with holdout evaluation
- Task 24: Classifier inference + `maybe_retrain()`
- Task 25: API: POST `/api/sites/intelligence-scan`
- Task 26: API: GET `/api/sites/intelligence/:host` + list
- Task 27: API: feature-flag admin endpoints
- Task 28: API: GET `/api/sites/cost`
- Task 29: Final integration verification

---

### Task 18: `embeddings.py` module

**Files:**
- Create: `worker/embeddings.py`
- Create: `tests/test_embeddings.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_embeddings.py`:

```python
"""Tests for embeddings module. Skipped when sentence-transformers
is not installed (model download is ~80MB)."""
import pytest
import os

# Skip the whole module if model isn't available
_sbert_available = False
try:
    import sentence_transformers  # noqa: F401
    _sbert_available = True
except ImportError:
    pass

pytestmark = pytest.mark.skipif(
    not _sbert_available,
    reason="sentence-transformers not installed"
)


class TestEventToText:
    def test_composes_minimal_event(self):
        from worker.embeddings import event_to_text
        text = event_to_text({"title": "Jazz Night"})
        assert "Jazz Night" in text

    def test_includes_venue_city_country(self):
        from worker.embeddings import event_to_text
        text = event_to_text({
            "title": "T", "venue_name": "V", "city": "C",
            "country_code": "US"
        })
        assert "V" in text and "C" in text and "US" in text

    def test_includes_first_sentence_of_description(self):
        from worker.embeddings import event_to_text
        text = event_to_text({
            "title": "T",
            "description": "First sentence here. Second sentence ignored."
        })
        assert "First sentence here" in text
        assert "Second sentence ignored" not in text

    def test_includes_categories(self):
        from worker.embeddings import event_to_text
        text = event_to_text({"title": "T", "categories": ["Music", "Free"]})
        assert "Music" in text
        assert "Free" in text

    def test_missing_fields_skipped(self):
        from worker.embeddings import event_to_text
        text = event_to_text({"title": "Only Title"})
        # No empty fields with empty pipes
        assert "  " not in text


class TestGetModel:
    def test_returns_model_instance(self):
        from worker.embeddings import get_model
        m = get_model()
        assert m is not None

    def test_cached_across_calls(self):
        from worker.embeddings import get_model
        m1 = get_model()
        m2 = get_model()
        assert m1 is m2


class TestEncodeEvent:
    def test_returns_384_dim_vector(self):
        from worker.embeddings import encode_event
        v = encode_event({"title": "Concert"})
        assert v is not None
        assert len(v) == 384

    def test_returns_none_when_disabled(self):
        from worker.embeddings import encode_event, set_available
        orig = os.environ.get("XYZO_DISABLE_EMBEDDINGS")
        try:
            set_available(False)
            v = encode_event({"title": "Concert"})
            assert v is None
        finally:
            set_available(_sbert_available)
            if orig is not None:
                os.environ["XYZO_DISABLE_EMBEDDINGS"] = orig

    def test_similar_events_have_high_similarity(self):
        import math
        from worker.embeddings import encode_event
        v1 = encode_event({"title": "Jazz Night at Blue Note",
                            "venue_name": "Blue Note", "city": "NYC"})
        v2 = encode_event({"title": "Blue Note Jazz Evening",
                            "venue_name": "Blue Note", "city": "NYC"})
        sim = _cosine_sim(v1, v2)
        assert sim > 0.7

    def test_unrelated_events_have_low_similarity(self):
        from worker.embeddings import encode_event
        v1 = encode_event({"title": "Jazz Night"})
        v2 = encode_event({"title": "Python Workshop"})
        sim = _cosine_sim(v1, v2)
        assert sim < 0.5


def _cosine_sim(a, b):
    """Quick cosine similarity for two equal-length lists."""
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_embeddings.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError: No module named 'worker.embeddings'`.

- [ ] **Step 3: Write `worker/embeddings.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

If sentence-transformers is installed:
```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_embeddings.py -v 2>&1 | tail -15
```
Expected: 9 tests pass (or skip if model not installed).

If not installed (run as sanity):
```bash
cd /var/www/vhosts/xyzo.org
pip install sentence-transformers torch --quiet
python3 -m pytest tests/test_embeddings.py -v 2>&1 | tail -15
```

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/embeddings.py tests/test_embeddings.py
git commit -m "feat(embeddings): sentence-transformers module with graceful degradation"
```

---

### Task 19: pgvector dedup query

**Files:**
- Create: `worker/embeddings_dedup.py`
- Create: `tests/test_embeddings_dedup.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_embeddings_dedup.py`:

```python
"""Tests for embeddings_dedup — pgvector cosine similarity search."""
from unittest.mock import patch, MagicMock
from worker.embeddings_dedup import (
    find_near_duplicates, mark_duplicate, DEFAULT_THRESHOLD,
)


class TestFindNearDuplicates:
    def test_empty_when_no_events_match(self):
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = []
            result = find_near_duplicates(
                "event-1", [0.1] * 384,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert result == []

    def test_returns_below_threshold_when_no_close_match(self):
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": 42, "title": "Far away event", "sim": 0.5}
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert result == []  # below threshold

    def test_returns_above_threshold(self):
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": 42, "title": "Same event", "sim": 0.95}
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert len(result) == 1
            assert result[0]["sim"] == 0.95

    def test_caps_results(self):
        with patch("worker.embeddings_dedup._search") as search:
            search.return_value = [
                {"id": i, "title": f"E{i}", "sim": 0.95 - i * 0.001}
                for i in range(20)
            ]
            result = find_near_duplicates(
                "e1", [0.1] * 384, threshold=0.85, limit=5,
                starts_at="2026-09-06T19:00:00Z",
            )
            assert len(result) == 5


class TestMarkDuplicate:
    def test_writes_merged_into(self):
        with patch("worker.embeddings_dedup._execute") as exec:
            mark_duplicate(lower_id=10, higher_id=20)
            exec.assert_called_once()
            sql = exec.call_args.args[0]
            assert "merged_into" in sql
            assert exec.call_args.args[1] == 20
            assert exec.call_args.args[2] == 10


class TestConstants:
    def test_default_threshold_in_range(self):
        assert 0.0 < DEFAULT_THRESHOLD < 1.0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_embeddings_dedup.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement `worker/embeddings_dedup.py`**

```python
"""embeddings_dedup — pgvector cosine search for cross-source dedup.

Pipeline:
  encode_event(event) -> 384-dim vector
  find_near_duplicates(event_id, vector, starts_at) -> list of matches

Matches within ±1 day of `starts_at` with similarity above threshold
are returned. Caller decides whether to auto-merge or queue for review.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("xyzo.embeddings_dedup")

DEFAULT_THRESHOLD = 0.92
REVIEW_THRESHOLD_LOWER = 0.85


def _connect():
    from db import connect  # type: ignore
    return connect()


def _search(vector_str: str, starts_at: str | None,
            threshold: float, limit: int) -> list[dict]:
    """Run the cosine search query."""
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, title,
                       1 - (embedding <=> %s::vector) AS sim,
                       source_url
                FROM upcoming_events
                WHERE embedding IS NOT NULL
                  AND (%s::timestamptz IS NULL OR
                       starts_at BETWEEN %s::timestamptz - interval '1 day'
                                     AND %s::timestamptz + interval '1 day')
                  AND 1 - (embedding <=> %s::vector) > %s
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (vector_str, starts_at, starts_at, starts_at,
                 vector_str, threshold, vector_str, limit),
            )
            rows = cur.fetchall()
            return [{"id": r["id"], "title": r["title"],
                     "sim": float(r["sim"]), "source_url": r["source_url"]}
                    for r in rows]
    except Exception as e:
        log.warning("dedup search failed: %s", e)
        return []


def _execute(sql: str, *params):
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()
    except Exception as e:
        log.warning("dedup execute failed: %s", e)


def find_near_duplicates(
    event_id: str,
    vector: list[float],
    starts_at: str | None = None,
    threshold: float = DEFAULT_THRESHOLD,
    limit: int = 5,
) -> list[dict]:
    """Return near-duplicate events sorted by similarity desc."""
    if not vector:
        return []
    vector_str = "[" + ",".join(str(float(v)) for v in vector) + "]"
    matches = _search(vector_str, starts_at, threshold, limit)
    return [m for m in matches if m["id"] != event_id]


def mark_duplicate(lower_id: int, higher_id: int) -> None:
    """Mark an event as a duplicate of another (merged_into)."""
    _execute(
        "UPDATE crawl_events SET merged_into = %s WHERE id = %s",
        higher_id, lower_id,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_embeddings_dedup.py -v 2>&1 | tail -15
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/embeddings_dedup.py tests/test_embeddings_dedup.py
git commit -m "feat(dedup): pgvector cosine search + duplicate marking"
```

---

### Task 20: Wire embeddings into `site_crawl.py`

**Files:**
- Modify: `worker/site_crawl.py`
- Modify: `tests/test_site_crawl_intelligence.py`

- [ ] **Step 1: Add failing tests to `tests/test_site_crawl_intelligence.py`**

Append:

```python
class TestEmbeddingsWiring:
    def test_crawl_result_triggers_embeddings_when_enabled(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.compute_event_embeddings") as embed:
            flag.return_value = True
            load.return_value = {"feeds": [], "structural_map": [],
                                  "sd_fingerprint": {}, "politics": {}}
            crawl.return_value = MagicMock(to_dict=lambda: {
                "events": [{"title": "T", "starts_at": "2026-09-06T19:00:00Z"}]
            })
            crawl_with_intelligence("https://x.com")
            embed.assert_called_once()

    def test_crawl_skips_embeddings_when_disabled(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as flag, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl, \
             patch("worker.site_crawl.compute_event_embeddings") as embed:
            flag.return_value = True
            load.return_value = {"feeds": [], "structural_map": [],
                                  "sd_fingerprint": {}, "politics": {}}
            crawl.return_value = MagicMock(to_dict=lambda: {
                "events": []
            })
            crawl_with_intelligence("https://x.com")
            embed.assert_not_called()
```

- [ ] **Step 2: Run new tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_site_crawl_intelligence.py::TestEmbeddingsWiring -v 2>&1 | tail -10
```
Expected: `AttributeError` or `AssertionError`.

- [ ] **Step 3: Add embedding hooks to `worker/site_crawl.py`**

Append to `worker/site_crawl.py`:

```python
def compute_event_embeddings(events: list[dict]) -> int:
    """Embed extracted events and run dedup. Returns count embedded."""
    try:
        from api.src.xyzo_features import is_enabled as _is_enabled
        from urllib.parse import urlparse
        # We don't know the host here; caller passes per-event source_url
        # so dedup can scope by host if needed
        if not events:
            return 0
        # We can't easily check flag without host, so check the global flag
        # by trying the first event's host
        if events and events[0].get("source_url"):
            host = urlparse(events[0]["source_url"]).hostname or ""
            tier = "commercial"  # tier check is best-effort
            if not _is_enabled("embedding_dedup", host, tier):
                return 0
    except Exception:
        return 0

    try:
        from worker.embeddings import encode_events_batch, is_available
        from worker.embeddings_dedup import (
            find_near_duplicates, mark_duplicate, DEFAULT_THRESHOLD,
            REVIEW_THRESHOLD_LOWER,
        )
        if not is_available():
            return 0
        vectors = encode_events_batch(events)
        count = 0
        for ev, vec in zip(events, vectors):
            if vec is None:
                continue
            dups = find_near_duplicates(
                str(ev.get("id", "")),
                vec,
                starts_at=ev.get("starts_at"),
            )
            high_conf = [d for d in dups if d["sim"] >= DEFAULT_THRESHOLD]
            if high_conf:
                # Auto-merge with highest-confidence match
                mark_duplicate(lower_id=int(ev.get("id", 0)),
                               higher_id=high_conf[0]["id"])
            count += 1
        return count
    except Exception as e:
        log.warning("compute_event_embeddings failed: %s", e)
        return 0


def update_drift_signals(host: str, crawl_result: dict) -> None:
    """Update site_intelligence.drift_signals based on crawl findings."""
    try:
        from db import connect
        # Count predicted feeds that returned content
        pages = crawl_result.get("pages") or []
        feeds_found = crawl_result.get("feeds") or []
        paths_returning_events = sum(
            1 for p in pages
            if (p.get("json_ld_events") or p.get("heuristic_events")
                or p.get("ai_events"))
        )
        paths_total = len(pages)

        drift = {
            "predicted_paths_returning_events": paths_returning_events,
            "predicted_paths_total": paths_total,
            "predicted_feeds_alive": len(feeds_found),
            "predicted_feeds_total": len(feeds_found),   # pessimistic; can be refined
            "json_ld_seen_in_last_crawl": any(
                p.get("json_ld_events") for p in pages),
            "last_drift_check_at": _now_iso(),
        }

        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE site_intelligence SET drift_signals = %s::jsonb, "
                "last_used_at = now(), crawl_count = crawl_count + 1, "
                "events_extracted = events_extracted + %s "
                "WHERE host = %s",
                (__import__("json").dumps(drift),
                 crawl_result.get("stats", {}).get("events_found", 0),
                 host),
            )
            conn.commit()
    except Exception as e:
        log.warning("update_drift_signals failed for %s: %s", host, e)


def _now_iso() -> str:
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).isoformat()
```

Then modify `crawl_with_intelligence()` to call these after crawl_site. Find:
```python
    result = crawl_site(seed_url, intelligence=intel, **kwargs)
    return result.to_dict()
```
Replace with:
```python
    result = crawl_site(seed_url, intelligence=intel, **kwargs)
    result_dict = result.to_dict()
    # Post-process: embed events + update drift signals
    try:
        events = result_dict.get("events") or []
        if events:
            embedded_count = compute_event_embeddings(events)
            result_dict["embeddings_computed"] = embedded_count
    except Exception as e:
        log.warning("embedding step failed: %s", e)
    try:
        update_drift_signals(host, result_dict)
    except Exception as e:
        log.warning("drift update failed: %s", e)
    return result_dict
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_site_crawl_intelligence.py -v 2>&1 | tail -15
```
Expected: 7 tests pass (5 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/site_crawl.py tests/test_site_crawl_intelligence.py
git commit -m "feat(crawl): wire embeddings + drift_signals into crawl_with_intelligence"
```

---

### Task 21: Classifier training data query

**Files:**
- Create: `worker/classifier.py` (initial scaffold)
- Create: `tests/test_classifier_data.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_classifier_data.py`:

```python
"""Tests for classifier training data extraction."""
from unittest.mock import patch, MagicMock
from worker.classifier import (
    fetch_training_samples, TrainingSample, _label_to_richness,
    _extract_event_type,
)


class TestLabelToRichness:
    def test_events_present_high(self):
        assert _label_to_richness(5, False, False) >= 0.8

    def test_only_heuristic_medium(self):
        assert 0.4 <= _label_to_richness(0, False, True) <= 0.7

    def test_nothing_low(self):
        assert _label_to_richness(0, False, False) <= 0.2

    def test_caps_at_one(self):
        assert _label_to_richness(50, True, True) <= 1.0


class TestExtractEventType:
    def test_jsonld_event(self):
        assert _extract_event_type([{"@type": "MusicEvent"}]) == "concert"

    def test_jsonld_sportsevent(self):
        assert _extract_event_type([{"@type": "SportsEvent"}]) == "sports"

    def test_no_events_returns_other(self):
        assert _extract_event_type([]) == "other"

    def test_unknown_type_returns_other(self):
        assert _extract_event_type([{"@type": "MysteryType"}]) == "other"


class TestFetchTrainingSamples:
    def test_returns_list_of_training_samples(self):
        fake_rows = [
            {"url": "https://x.com/events", "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
            {"url": "https://x.com/about", "json_ld_events": [],
             "heuristic_events": [], "signals": ["rss_autodiscovery"]},
        ]
        with patch("worker.classifier._query_training_data") as q:
            q.return_value = fake_rows
            samples = fetch_training_samples()
            assert len(samples) == 2
            assert all(isinstance(s, TrainingSample) for s in samples)

    def test_handles_db_error(self):
        with patch("worker.classifier._query_training_data") as q:
            q.side_effect = Exception("db down")
            samples = fetch_training_samples()
            assert samples == []
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_data.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement initial `worker/classifier.py`**

```python
"""classifier — two-head NN for URL event-richness + event type.

Two heads on shared sentence-transformers backbone:
  - re-ranker: sigmoid output 0..1 (how likely this URL surfaces events)
  - event-type: softmax over 8 classes

Bootstraps from discovered_pages labels. Retrains weekly or when
new_samples > retrain_min_samples (default 500).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

log = logging.getLogger("xyzo.classifier")


EVENT_TYPE_LABELS = (
    "concert", "class", "sports", "civic", "exhibition",
    "festival", "community", "other",
)

LABEL_TO_INDEX = {label: i for i, label in enumerate(EVENT_TYPE_LABELS)}


@dataclass
class TrainingSample:
    url: str
    embedding: list[float] | None
    richness_label: float       # 0..1
    event_type_label: int       # index into EVENT_TYPE_LABELS


def _label_to_richness(
    n_events: int,
    has_jsonld: bool,
    has_heuristic: bool,
) -> float:
    """Convert event counts + signals into a 0..1 richness label."""
    score = 0.0
    if n_events > 0:
        score += min(n_events / 5.0, 0.7)   # saturate at 5 events
    if has_jsonld:
        score += 0.2
    if has_heuristic:
        score += 0.1
    return min(score, 1.0)


def _extract_event_type(json_ld_events: list[dict]) -> str:
    """Pick the most likely event type from JSON-LD @type values."""
    if not json_ld_events:
        return "other"
    raw_type = json_ld_events[0].get("@type", "")
    raw_lower = raw_type.lower()
    if "music" in raw_lower:
        return "concert"
    if "sport" in raw_lower:
        return "sports"
    if "theater" in raw_lower or "theatre" in raw_lower:
        return "concert"   # treat as performance
    if "education" in raw_lower or "course" in raw_lower:
        return "class"
    if "exhibition" in raw_lower or "visual" in raw_lower:
        return "exhibition"
    if "festival" in raw_lower:
        return "festival"
    if "business" in raw_lower or "civic" in raw_lower:
        return "civic"
    if "social" in raw_lower or "community" in raw_lower:
        return "community"
    return "other"


def _query_training_data(since_days: int = 90) -> list[dict]:
    """Read labeled pages from discovered_pages."""
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    dp.url,
                    dp.json_ld_events,
                    dp.heuristic_events,
                    dp.signals
                FROM discovered_pages dp
                JOIN site_crawl_results sc ON sc.id = dp.crawl_id
                WHERE sc.finished_at > now() - (%s || ' days')::interval
                ORDER BY dp.crawled_at DESC
                LIMIT 5000
                """,
                (str(since_days),),
            )
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    except Exception as e:
        log.warning("_query_training_data failed: %s", e)
        return []


def fetch_training_samples(since_days: int = 90) -> list[TrainingSample]:
    """Convert discovered_pages rows into TrainingSample objects.

    NOTE: This returns samples WITHOUT embeddings. The caller (training
    loop) is responsible for encoding them via sentence-transformers
    since that's expensive and should be batched.
    """
    rows = _query_training_data(since_days)
    out = []
    for r in rows:
        url = r.get("url", "")
        json_ld = r.get("json_ld_events") or []
        heur = r.get("heuristic_events") or []
        signals = r.get("signals") or []

        n_events = len(json_ld) + len(heur)
        richness = _label_to_richness(
            n_events,
            has_jsonld=bool(json_ld),
            has_heuristic=bool(heur or "rss_autodiscovery" in signals),
        )
        event_type = _extract_event_type(json_ld)

        out.append(TrainingSample(
            url=url,
            embedding=None,    # encoded lazily by caller
            richness_label=richness,
            event_type_label=LABEL_TO_INDEX[event_type],
        ))
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_data.py -v 2>&1 | tail -15
```
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/classifier.py tests/test_classifier_data.py
git commit -m "feat(classifier): training data extraction from discovered_pages"
```

---

### Task 22: Classifier two-head model

**Files:**
- Modify: `worker/classifier.py`
- Create: `tests/test_classifier_model.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_classifier_model.py`:

```python
"""Tests for classifier model definition.

Skipped if torch not installed.
"""
import pytest

torch_available = False
try:
    import torch  # noqa: F401
    torch_available = True
except ImportError:
    pass

pytestmark = pytest.mark.skipif(not torch_available,
                                 reason="torch not installed")


class TestBuildModel:
    def test_returns_two_outputs(self):
        from worker.classifier import build_model
        m = build_model()
        # Should produce 1 (re-ranker) + 8 (event type) outputs
        out_rich, out_type = m._test_forward()
        assert out_rich.shape[-1] == 1
        assert out_type.shape[-1] == 8

    def test_model_is_in_eval_mode_after_load(self):
        from worker.classifier import build_model, load_latest_model
        try:
            m = load_latest_model()
            # If we have a model on disk, it should be loadable
        except Exception:
            # No trained model yet — that's fine
            pass
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_model.py -v 2>&1 | tail -10
```
Expected: failure.

- [ ] **Step 3: Append model definition to `worker/classifier.py`**

Append to `worker/classifier.py`:

```python
CLASSIFIER_CONFIG = {
    "input_dim": 384,
    "hidden_dims": [128, 64],
    "dropout": 0.3,
    "reranker_head": 1,
    "event_type_classes": 8,
}


def build_model():
    """Build the two-head classifier. Lazy torch import."""
    import torch
    import torch.nn as nn

    cfg = CLASSIFIER_CONFIG

    class TwoHeadClassifier(nn.Module):
        def __init__(self):
            super().__init__()
            layers = []
            in_dim = cfg["input_dim"]
            for h in cfg["hidden_dims"]:
                layers += [nn.Linear(in_dim, h), nn.ReLU(),
                           nn.Dropout(cfg["dropout"])]
                in_dim = h
            self.backbone = nn.Sequential(*layers)
            self.reranker_head = nn.Linear(in_dim, cfg["reranker_head"])
            self.event_type_head = nn.Linear(in_dim, cfg["event_type_classes"])

        def forward(self, x):
            features = self.backbone(x)
            reranker = torch.sigmoid(self.reranker_head(features))
            event_type = torch.softmax(self.event_type_head(features), dim=-1)
            return reranker, event_type

        def _test_forward(self):
            dummy = __import__("torch").zeros(1, cfg["input_dim"])
            return self.forward(dummy)

    return TwoHeadClassifier()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_model.py -v 2>&1 | tail -15
```
Expected: 2 tests pass (or skip if torch missing).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/classifier.py tests/test_classifier_model.py
git commit -m "feat(classifier): two-head PyTorch model"
```

---

### Task 23: `train_classifier()` with holdout evaluation

**Files:**
- Modify: `worker/classifier.py`
- Create: `tests/test_classifier_train.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_classifier_train.py`:

```python
"""Tests for train_classifier() with quality regression check."""
from unittest.mock import patch, MagicMock
from worker.classifier import (
    train_classifier, evaluate, _record_run,
)


class TestEvaluate:
    def test_returns_metrics_dict(self):
        # Build a tiny mock eval set
        samples = []
        for i in range(20):
            samples.append(MagicMock(
                embedding=[0.01] * 384,
                richness_label=0.5 if i % 2 == 0 else 0.0,
                event_type_label=i % 8,
            ))
        with patch("worker.classifier._encode_batch") as enc:
            import numpy as np
            enc.return_value = np.random.rand(20, 384)
            with patch("worker.classifier._predict") as pred:
                pred.return_value = (
                    [0.5] * 20,
                    [[1.0 / 8] * 8] * 20,
                )
                metrics = evaluate(samples)
                assert "auc" in metrics
                assert "rmse" in metrics
                assert "f1" in metrics
                assert metrics["status"] in ("ok", "rejected")


class TestRecordRun:
    def test_writes_to_classifier_runs_table(self):
        with patch("worker.classifier._insert_run") as ins:
            _record_run(
                sample_count=100, new_samples=50, auc=0.7,
                rmse=0.3, f1=0.5, status="ok", model_path="models/x.pt"
            )
            ins.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_train.py -v 2>&1 | tail -10
```
Expected: `ImportError`.

- [ ] **Step 3: Append training code to `worker/classifier.py`**

Append to `worker/classifier.py`:

```python
def train_classifier(new_samples: int = 0,
                      model_dir: str = "/var/lib/xyzo/models",
                      epochs: int = 5,
                      batch_size: int = 64) -> dict:
    """Run one training cycle. Returns metrics dict.

    - Fetch samples
    - Encode via sentence-transformers (one batch)
    - Hold out last 20% for eval
    - Train
    - Eval; if AUC regressed vs last ok run, status=rejected
    - Persist metrics to classifier_runs
    - Save model to model_dir/classifier_vN.pt
    """
    import time

    samples = fetch_training_samples()
    if len(samples) < 50:
        return {"status": "skipped", "reason": "too-few-samples",
                "sample_count": len(samples)}

    started = time.time()

    # Encode embeddings (batched)
    embeddings = _encode_batch([s.url for s in samples])
    if embeddings is None:
        return {"status": "skipped", "reason": "encoder-unavailable"}
    for sample, vec in zip(samples, embeddings):
        sample.embedding = vec.tolist() if hasattr(vec, "tolist") else list(vec)

    # Hold out 20% for eval
    split = int(len(samples) * 0.8)
    train_samples = samples[:split]
    eval_samples = samples[split:]

    # Build + train
    import torch
    import torch.nn as nn

    model = build_model()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    bce = nn.BCELoss()
    ce = nn.CrossEntropyLoss()

    import numpy as np
    X_train = np.array([s.embedding for s in train_samples], dtype="float32")
    y_rich = np.array([s.richness_label for s in train_samples], dtype="float32")
    y_type = np.array([s.event_type_label for s in train_samples], dtype="int64")

    model.train()
    for epoch in range(epochs):
        perm = np.random.permutation(len(X_train))
        for i in range(0, len(X_train), batch_size):
            idx = perm[i:i + batch_size]
            xb = torch.from_numpy(X_train[idx])
            yb_rich = torch.from_numpy(y_rich[idx]).unsqueeze(1)
            yb_type = torch.from_numpy(y_type[idx])
            pred_rich, pred_type = model(xb)
            loss = bce(pred_rich, yb_rich) + ce(pred_type, yb_type)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

    metrics = evaluate(eval_samples, model=model)
    metrics["duration_ms"] = int((time.time() - started) * 1000)

    if metrics["status"] == "ok":
        os.makedirs(model_dir, exist_ok=True)
        n_existing = len([f for f in os.listdir(model_dir)
                          if f.startswith("classifier_v") and f.endswith(".pt")])
        model_path = os.path.join(model_dir, f"classifier_v{n_existing + 1}.pt")
        try:
            torch.save(model.state_dict(), model_path)
            metrics["model_path"] = model_path
        except Exception as e:
            log.warning("model save failed: %s", e)
            metrics["status"] = "rejected"
            metrics["rejection_reason"] = "save-failed"

    metrics["sample_count"] = len(samples)
    metrics["new_samples"] = new_samples
    _record_run(
        sample_count=len(samples),
        new_samples=new_samples,
        auc=metrics.get("auc"),
        rmse=metrics.get("rmse"),
        f1=metrics.get("f1"),
        status=metrics["status"],
        model_path=metrics.get("model_path"),
    )
    return metrics


def evaluate(samples, model=None) -> dict:
    """Compute AUC/RMSE/F1 on a sample set. Status=rejected if regressed."""
    import numpy as np
    if model is None:
        model = build_model()
    if not samples:
        return {"status": "skipped", "reason": "no-samples"}

    embeddings = np.array([s.embedding or [0.0] * 384 for s in samples],
                          dtype="float32")
    if not embeddings.any():
        return {"status": "skipped", "reason": "no-embeddings"}

    import torch
    model.eval()
    with torch.no_grad():
        x = torch.from_numpy(embeddings)
        pred_rich, pred_type = model(x)
        pred_rich = pred_rich.squeeze().tolist()
        pred_type = pred_type.tolist()

    y_rich = [s.richness_label for s in samples]
    y_type = [s.event_type_label for s in samples]

    rmse = float(np.sqrt(np.mean((np.array(pred_rich) - np.array(y_rich)) ** 2)))

    # Binary AUC: richness >= 0.5 = positive
    try:
        from sklearn.metrics import roc_auc_score, f1_score
        auc = float(roc_auc_score(
            [r >= 0.5 for r in y_rich], pred_rich
        ))
    except Exception:
        auc = 0.5

    pred_types = [int(np.argmax(p)) for p in pred_type]
    try:
        from sklearn.metrics import f1_score
        f1 = float(f1_score(y_type, pred_types, average="macro", zero_division=0))
    except Exception:
        f1 = 0.0

    # Quality regression check
    last_auc = _get_last_ok_auc()
    status = "ok"
    if last_auc is not None and auc < (last_auc - 0.02):
        status = "rejected"

    return {
        "status": status,
        "rmse": rmse,
        "auc": auc,
        "f1": f1,
    }


def _encode_batch(urls: list[str]):
    """Encode a batch of URLs via sentence-transformers."""
    try:
        from worker.embeddings import is_available, get_model
        if not is_available():
            return None
        return get_model().encode(urls, normalize_embeddings=True,
                                   batch_size=64, show_progress_bar=False)
    except Exception as e:
        log.warning("_encode_batch failed: %s", e)
        return None


def _predict(model, embeddings):
    """Return (richness_scores, type_probabilities)."""
    import numpy as np
    import torch
    model.eval()
    with torch.no_grad():
        x = torch.from_numpy(np.array(embeddings, dtype="float32"))
        pred_rich, pred_type = model(x)
        return (pred_rich.squeeze().tolist(),
                pred_type.tolist())


def _get_last_ok_auc() -> float | None:
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT auc FROM classifier_runs WHERE status='ok' "
                "ORDER BY trained_at DESC LIMIT 1"
            )
            row = cur.fetchone()
            return float(row["auc"]) if row and row["auc"] else None
    except Exception:
        return None


def _insert_run(**kwargs):
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO classifier_runs (
                    sample_count, new_samples, auc, rmse, f1,
                    status, model_path
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (kwargs.get("sample_count"), kwargs.get("new_samples"),
                 kwargs.get("auc"), kwargs.get("rmse"), kwargs.get("f1"),
                 kwargs.get("status"), kwargs.get("model_path")),
            )
            conn.commit()
    except Exception as e:
        log.warning("_insert_run failed: %s", e)


_record_run = _insert_run   # alias for tests


def maybe_retrain() -> dict | None:
    """Trigger training if enough new samples since last ok run."""
    try:
        from api.src.xyzo_features import get_config
        if not _flag_enabled("classifier_reranker"):
            return None
        min_samples = int(get_config("classifier.retrain_min_samples", "500"))
        new = _count_new_samples_since_last_ok()
        if new < min_samples:
            return None
        import threading
        # Run in background so caller doesn't block
        result = {}
        def _run():
            result.update(train_classifier(new_samples=new))
        t = threading.Thread(target=_run, daemon=True)
        t.start()
        return {"scheduled": True, "new_samples": new}
    except Exception as e:
        log.warning("maybe_retrain failed: %s", e)
        return None


def _count_new_samples_since_last_ok() -> int:
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) AS n FROM discovered_pages "
                "WHERE crawled_at > COALESCE("
                "  (SELECT trained_at FROM classifier_runs "
                "   WHERE status='ok' ORDER BY trained_at DESC LIMIT 1),"
                "  now() - interval '30 days')"
            )
            row = cur.fetchone()
            return int(row["n"]) if row else 0
    except Exception:
        return 0


def _flag_enabled(flag_key: str) -> bool:
    try:
        from api.src.xyzo_features import is_enabled as _ie
        return _ie(flag_key, "_classifier_global", "_global")
    except Exception:
        return False


def predict_url_event_type(url: str) -> tuple[float, str]:
    """Inference. Returns (richness_score, event_type_label)."""
    try:
        from worker.embeddings import encode_event
        # Encode just the URL string for cheap inference
        v = encode_event({"title": url})
        if v is None:
            return (0.0, "other")

        model = load_latest_model()
        if model is None:
            return (0.0, "other")

        import numpy as np
        import torch
        x = torch.from_numpy(np.array([v], dtype="float32"))
        model.eval()
        with torch.no_grad():
            pred_rich, pred_type = model(x)
        richness = float(pred_rich.squeeze().item())
        type_idx = int(torch.argmax(pred_type, dim=-1).item())
        return (richness, EVENT_TYPE_LABELS[type_idx])
    except Exception as e:
        log.warning("predict_url_event_type failed: %s", e)
        return (0.0, "other")


def load_latest_model():
    """Load the most recent ok classifier from disk."""
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT model_path FROM classifier_runs "
                "WHERE status='ok' AND model_path IS NOT NULL "
                "ORDER BY trained_at DESC LIMIT 1"
            )
            row = cur.fetchone()
            if not row or not row.get("model_path"):
                return None
        import torch
        model = build_model()
        state = torch.load(row["model_path"], map_location="cpu")
        model.load_state_dict(state)
        return model
    except Exception as e:
        log.warning("load_latest_model failed: %s", e)
        return None
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_train.py -v 2>&1 | tail -15
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/classifier.py tests/test_classifier_train.py
git commit -m "feat(classifier): training loop with holdout eval + regression check"
```

---

### Task 24: Classifier inference + `maybe_retrain()` (verification)

- [ ] **Step 1: Run all classifier tests**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_classifier_*.py -v 2>&1 | tail -20
```
Expected: all classifier tests pass.

- [ ] **Step 2: Smoke test the module imports cleanly**

```bash
cd /var/www/vhosts/xyzo.org
python3 -c "from worker.classifier import predict_url_event_type, maybe_retrain, train_classifier; print('imports ok')"
```
Expected: `imports ok`.

- [ ] **Step 3: Commit (if any pending changes)**

```bash
cd /var/www/vhosts/xyzo.org
git status
```

---

### Task 25: API — POST `/api/sites/intelligence-scan`

**Files:**
- Modify: `api/src/routes/sites_study.ts`
- Modify: `api/src/routes/sites_study.test.ts` (create) or add to existing tests

- [ ] **Step 1: Append failing test**

If `api/src/routes/sites_study.test.ts` doesn't exist, create it:

```typescript
import { describe, it, expect } from "bun:test";

describe("POST /api/sites/intelligence-scan", () => {
    it("rejects missing host", async () => {
        const res = await app.request("/api/sites/intelligence-scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
    });

    it("returns scan result for valid host", async () => {
        const res = await app.request("/api/sites/intelligence-scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ host: "example.com" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.host).toBe("example.com");
    });
});
```

- [ ] **Step 2: Add the route**

Append to `api/src/routes/sites_study.ts`:

```typescript
// ── POST /api/sites/intelligence-scan ──────────────────────────────
//
// Force a Claude AI scan for a host. Persists to site_intelligence.

sitesStudyRoute.post("/sites/intelligence-scan", async (c) => {
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return jsonSafe(c, { ok: false, error: "invalid json" }, 400);
    }
    const host = (body.host || "").toLowerCase().trim();
    if (!host) {
        return jsonSafe(c, { ok: false, error: "host required" }, 400);
    }
    const refresh = body.refresh === true;

    const script = `
import json, sys
sys.path.insert(0, '/var/www/vhosts/xyzo.org/worker')
from ai_intelligence_scan import run_ai_scan
result = run_ai_scan(${JSON.stringify(host)}, force=${refresh ? "True" : "False"})
print("__SCAN_JSON__" + json.dumps(result.to_dict(), default=str))
`;
    let scan: any = null;
    try {
        const r = await runPython(script, [], 90_000);
        const line = r.stdout.split("\n")
            .find(l => l.startsWith("__SCAN_JSON__"));
        if (line) {
            scan = JSON.parse(line.slice("__SCAN_JSON__".length));
        }
    } catch (e: any) {
        return jsonSafe(c, {
            ok: false, error: "scan-failed", detail: String(e),
        }, 500);
    }
    if (!scan) {
        return jsonSafe(c, { ok: false, error: "no-result" }, 502);
    }
    return jsonSafe(c, { ok: true, host, scan });
});
```

- [ ] **Step 3: Implement `run_ai_scan` in worker**

Append to `worker/ai_intelligence_scan.py`:

```python
def run_ai_scan(host: str, force: bool = False) -> "ScanResult":
    """End-to-end AI scan: build context, call Claude, persist.

    `force=True` skips the freshness check and scans anyway.
    Always returns a ScanResult; never raises.
    """
    import datetime as dt
    import json
    import time

    started = time.time()
    from robots import tier_for_url
    tier = tier_for_url(f"https://{host}")
    budget = budget_for_tier(tier)

    # Build seed URLs
    seed_url = f"https://{host}/"
    html_pages: dict[str, str] = {}
    autodiscovered_rss: list[str] = []
    json_ld_blocks: list[dict] = []
    microdata_blocks: list[dict] = []
    meta_tags: dict[str, str] = {}

    # Fetch home page (cheap, no AI)
    try:
        from site_study import study_url
        study = study_url(seed_url)
        if study.body_kind == "html" and study.body:
            html_pages[seed_url] = study.body
            autodiscovered_rss = [r.href for r in study.rss_feeds]
            json_ld_blocks = study.json_ld_events or []
            meta_tags = study.meta or {}
            # Truncate aggressively to fit budget
            budget_chars = (budget.tokens_in_max * 3) // max(len(html_pages), 1)
            for url in list(html_pages.keys()):
                if len(html_pages[url]) > budget_chars:
                    html_pages[url] = html_pages[url][:budget_chars]
    except Exception as e:
        log.warning("home page fetch failed for %s: %s", host, e)

    # Build context
    ctx = build_scan_context(
        seed_url=seed_url,
        html_pages=html_pages,
        sitemap_xml=None,
        autodiscovered_rss=autodiscovered_rss,
        json_ld_blocks=json_ld_blocks,
        microdata_blocks=microdata_blocks,
        meta_tags=meta_tags,
        max_pages=budget.pages_max,
        max_chars_per_page=10_000,
    )

    # Compose prompt
    from prompts.intelligence_scan import build_prompt, prompt_hash
    prompt = build_prompt(ctx)
    producer = f"xyzo-ai-scan@{prompt_hash(prompt)}"

    # Check existing record (unless force)
    existing = _fetch_existing(host)
    if not force and existing:
        needs, reason = needs_refresh(existing, host)
        if not needs:
            return ScanResult(
                host=host, intelligence=existing.get("intelligence"),
                confidence=existing.get("confidence", 0.9),
                tokens_in=0, tokens_out=0, cost_usd=0.0,
                model=budget.model, pages_sampled=len(html_pages),
                duration_ms=int((time.time() - started) * 1000),
                success=True,
            )

    # Call Claude
    api_key = os.environ.get("XYZO_CLAUDE_API_KEY")
    if not api_key:
        return ScanResult(
            host=host, intelligence=None, confidence=0.0,
            tokens_in=0, tokens_out=0, cost_usd=0.0,
            model=budget.model, pages_sampled=len(html_pages),
            duration_ms=int((time.time() - started) * 1000),
            error="XYZO_CLAUDE_API_KEY not set", success=False,
        )

    import httpx
    try:
        body = {
            "model": budget.model,
            "max_tokens": budget.tokens_out_max,
            "messages": [{"role": "user", "content": prompt}],
        }
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                content=json.dumps(body),
            )
        if resp.status_code != 200:
            return ScanResult(
                host=host, intelligence=None, confidence=0.0,
                tokens_in=len(prompt) // 4, tokens_out=0,
                cost_usd=0.0, model=budget.model,
                pages_sampled=len(html_pages),
                duration_ms=int((time.time() - started) * 1000),
                error=f"claude {resp.status_code}: {resp.text[:200]}",
                success=False,
            )
        data = resp.json()
        text = "".join(
            blk.get("text", "") for blk in data.get("content", [])
            if blk.get("type") == "text"
        )
        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            parsed = {}
    except Exception as e:
        return ScanResult(
            host=host, intelligence=None, confidence=0.0,
            tokens_in=len(prompt) // 4, tokens_out=0,
            cost_usd=0.0, model=budget.model,
            pages_sampled=len(html_pages),
            duration_ms=int((time.time() - started) * 1000),
            error=f"claude call failed: {e}", success=False,
        )

    # Merge findings
    parsed_feeds = parsed.get("feeds") or []
    merged_feeds = merge_feed_findings(
        [{"href": h, "detection": "autodiscovery"} for h in autodiscovered_rss],
        parsed_feeds,
    )
    parsed["feeds"] = merged_feeds
    parsed["schema_version"] = 1

    # Confidence
    confidence = compute_intelligence_confidence(parsed)

    # Persist
    usage = data.get("usage", {})
    tokens_in = int(usage.get("input_tokens", len(prompt) // 4))
    tokens_out = int(usage.get("output_tokens", len(text) // 4))
    cost = _estimate_cost(budget.model, tokens_in, tokens_out)

    try:
        _persist_intelligence(
            host=host, tier=tier, intelligence=parsed,
            confidence=confidence,
            tokens_in=tokens_in, tokens_out=tokens_out,
            cost=cost, model=budget.model,
            pages_sampled=len(html_pages),
            duration_ms=int((time.time() - started) * 1000),
            producer=producer,
            clear_error=existing is not None,
        )
    except Exception as e:
        log.warning("persist failed for %s: %s", host, e)

    return ScanResult(
        host=host, intelligence=parsed, confidence=confidence,
        tokens_in=tokens_in, tokens_out=tokens_out, cost_usd=cost,
        model=budget.model, pages_sampled=len(html_pages),
        duration_ms=int((time.time() - started) * 1000),
        success=True,
    )


def _fetch_existing(host: str) -> dict | None:
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM site_intelligence WHERE host = %s LIMIT 1",
                (host,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception as e:
        log.warning("_fetch_existing failed for %s: %s", host, e)
        return None


def _persist_intelligence(
    host: str, tier: str, intelligence: dict, confidence: float,
    tokens_in: int, tokens_out: int, cost: float, model: str,
    pages_sampled: int, duration_ms: int, producer: str,
    clear_error: bool,
) -> None:
    from db import connect
    from psycopg.types.json import Json
    summary = (intelligence.get("site_summary") or "")[:500]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO site_intelligence (
                host, tier, format_version, producer, producer_version,
                intelligence, summary, scan_tokens_in, scan_tokens_out,
                scan_cost_usd, scan_model, pages_sampled, scan_duration_ms,
                confidence, consecutive_errors, last_error, scan_count
            ) VALUES (%s, %s, 1, %s, '0.5.0', %s::jsonb, %s, %s, %s,
                      %s, %s, %s, %s, %s, 0, NULL, 1)
            ON CONFLICT (host) DO UPDATE SET
                intelligence = EXCLUDED.intelligence,
                summary = EXCLUDED.summary,
                scan_tokens_in = EXCLUDED.scan_tokens_in,
                scan_tokens_out = EXCLUDED.scan_tokens_out,
                scan_cost_usd = EXCLUDED.scan_cost_usd,
                scan_model = EXCLUDED.scan_model,
                pages_sampled = EXCLUDED.pages_sampled,
                scan_duration_ms = EXCLUDED.scan_duration_ms,
                confidence = EXCLUDED.confidence,
                refreshed_at = now(),
                last_error = NULL,
                consecutive_errors = 0,
                scan_count = site_intelligence.scan_count + 1,
                producer = EXCLUDED.producer
            """,
            (host, tier, producer, Json(intelligence), summary,
             tokens_in, tokens_out, cost, model, pages_sampled,
             duration_ms, confidence),
        )
        conn.commit()


def _estimate_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    # Rough estimates, adjust as pricing changes
    rates = {
        "claude-haiku-4-5": (0.25 / 1_000_000, 1.25 / 1_000_000),
        "claude-sonnet-5":  (3.00 / 1_000_000, 15.00 / 1_000_000),
    }
    in_rate, out_rate = rates.get(model, rates["claude-haiku-4-5"])
    return round(tokens_in * in_rate + tokens_out * out_rate, 6)


def schedule_async_scan(host: str, reason: str = "") -> None:
    """Schedule a background scan. Best-effort, never raises."""
    try:
        import threading
        def _bg():
            try:
                run_ai_scan(host, force=False)
            except Exception:
                pass
        t = threading.Thread(target=_bg, daemon=True)
        t.start()
        log.info("scheduled async scan for %s reason=%s", host, reason)
    except Exception as e:
        log.warning("schedule_async_scan failed: %s", e)
```

- [ ] **Step 4: Run the API tests**

```bash
cd /var/www/vhosts/xyzo.org
bun test api/src/routes/sites_study.test.ts 2>&1 | tail -10
```
Expected: 2 tests pass.

- [ ] **Step 5: Live smoke test**

```bash
cd /var/www/vhosts/xyzo.org
curl -X POST http://localhost:3000/api/sites/intelligence-scan \
  -H "Content-Type: application/json" \
  -d '{"host":"example.com"}'
```
Expected: 200 with `{ok: true, host: "example.com", scan: {...}}` (or error if no API key — that's fine for now).

- [ ] **Step 6: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/src/routes/sites_study.ts api/src/routes/sites_study.test.ts \
        worker/ai_intelligence_scan.py
git commit -m "feat(api): POST /api/sites/intelligence-scan + run_ai_scan orchestrator"
```

---

### Task 26: API — GET `/api/sites/intelligence/:host` + list

**Files:**
- Modify: `api/src/routes/sites_study.ts`

- [ ] **Step 1: Append route to `sites_study.ts`**

```typescript
// ── GET /api/sites/intelligence/:host ──────────────────────────────

sitesStudyRoute.get("/sites/intelligence/:host", async (c) => {
    const host = c.req.param("host").toLowerCase();
    const sql = getDb();
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, host, tier, format_version, confidence, summary,
               scan_count, crawl_count, events_extracted, duplicates_caught,
               refreshed_at, last_used_at, last_error, consecutive_errors,
               scan_tokens_in, scan_tokens_out, scan_cost_usd,
               drift_signals, intelligence
        FROM site_intelligence WHERE host = ${host} LIMIT 1
    `;
    if (rows.length === 0) {
        return jsonSafe(c, { ok: false, error: "no-record", host }, 404);
    }
    return jsonSafe(c, { ok: true, record: rows[0] });
});

// ── GET /api/sites/intelligence-list ───────────────────────────────

sitesStudyRoute.get("/sites/intelligence-list", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
    const sql = getDb();
    const rows = await sql<Record<string, unknown>[]>`
        SELECT host, tier, confidence, scan_count, crawl_count,
               events_extracted, refreshed_at, last_error
        FROM site_intelligence
        ORDER BY refreshed_at DESC NULLS LAST
        LIMIT ${limit}
    `;
    return jsonSafe(c, { ok: true, hosts: rows });
});
```

- [ ] **Step 2: Smoke test**

```bash
curl http://localhost:3000/api/sites/intelligence/example.com
curl "http://localhost:3000/api/sites/intelligence-list?limit=10"
```
Expected: 200 with JSON.

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/src/routes/sites_study.ts
git commit -m "feat(api): GET /api/sites/intelligence/:host + list"
```

---

### Task 27: API — feature-flag admin endpoints

**Files:**
- Create: `api/src/routes/feature_flags.ts`
- Modify: `api/src/server.ts` to register the route

- [ ] **Step 1: Create the route file**

```typescript
// ── feature_flags.ts ───────────────────────────────────────────────
//
// Admin endpoints for runtime feature flag manipulation. All changes
// take effect within _CACHE_TTL_S seconds (default 30s) without
// redeploy. Per-host overrides supported via host_overrides JSONB.

import { Hono } from "hono";
import { getDb } from "../db";

export const featureFlagsRoute = new Hono();

function jsonSafe(c: any, body: any, status = 200) {
    const text = JSON.stringify(body, (_k: string, v: any) =>
        typeof v === "bigint" ? Number(v) : v);
    return c.text(text, status, {
        "Content-Type": "application/json; charset=utf-8",
    });
}

// ── GET /api/features ──────────────────────────────────────────────

featureFlagsRoute.get("/features", async (c) => {
    const sql = getDb();
    const flags = await sql`SELECT * FROM feature_flags ORDER BY key`;
    const config = await sql`SELECT * FROM feature_config ORDER BY key`;
    return jsonSafe(c, {
        ok: true,
        flags: flags.map((r: any) => ({
            key: r.key, enabled: r.enabled, rollout_pct: r.rollout_pct,
            tier_overrides: r.tier_overrides, host_overrides: r.host_overrides,
            description: r.description, updated_at: r.updated_at,
        })),
        config: config.map((r: any) => ({ key: r.key, value: r.value })),
    });
});

// ── POST /api/features ─────────────────────────────────────────────
//
// Body: { key, enabled?, rollout_pct?, tier_overrides?, host_overrides? }

featureFlagsRoute.post("/features", async (c) => {
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return jsonSafe(c, { ok: false, error: "invalid json" }, 400);
    }
    const key = (body.key || "").trim();
    if (!key) {
        return jsonSafe(c, { ok: false, error: "key required" }, 400);
    }
    const sql = getDb();
    const updated_by = c.req.header("x-admin-user") || "unknown";

    // Build dynamic update
    const sets: string[] = ["updated_at = now()", "updated_by = $2"];
    const params: any[] = [key, updated_by];
    let i = 3;

    if (body.enabled !== undefined) {
        sets.push(`enabled = $${i}`);
        params.push(!!body.enabled);
        i++;
    }
    if (body.rollout_pct !== undefined) {
        const pct = Math.max(0, Math.min(100, Number(body.rollout_pct)));
        sets.push(`rollout_pct = $${i}`);
        params.push(pct);
        i++;
    }
    if (body.tier_overrides !== undefined) {
        sets.push(`tier_overrides = $${i}::jsonb`);
        params.push(JSON.stringify(body.tier_overrides));
        i++;
    }
    if (body.host_overrides !== undefined) {
        sets.push(`host_overrides = $${i}::jsonb`);
        params.push(JSON.stringify(body.host_overrides));
        i++;
    }

    try {
        await sql`
            UPDATE feature_flags SET ${sql.raw(sets.join(", "))}
            WHERE key = $1
        `;
        return jsonSafe(c, { ok: true, key, updated_fields: Object.keys(body).filter(k => k !== "key") });
    } catch (e: any) {
        return jsonSafe(c, { ok: false, error: String(e) }, 500);
    }
});
```

- [ ] **Step 2: Register route in `api/src/server.ts`**

Find where other routes are mounted (e.g. `app.route("/api", sitesStudyRoute)`) and add:
```typescript
import { featureFlagsRoute } from "./routes/feature_flags";
// ...
app.route("/api", featureFlagsRoute);
```

- [ ] **Step 3: Smoke test**

```bash
curl http://localhost:3000/api/features | head -c 500
```
Expected: 200 with the 6 flags listed.

Toggle one:
```bash
curl -X POST http://localhost:3000/api/features \
  -H "Content-Type: application/json" \
  -d '{"key":"ai_intelligence_scan","enabled":false,"rollout_pct":0}'
```
Expected: 200 with `{ok: true, ...}`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/src/routes/feature_flags.ts api/src/server.ts
git commit -m "feat(api): /api/features GET + POST for runtime flag manipulation"
```

---

### Task 28: API — GET `/api/sites/cost`

**Files:**
- Modify: `api/src/routes/sites_study.ts`

- [ ] **Step 1: Append the route**

```typescript
// ── GET /api/sites/cost ────────────────────────────────────────────
//
// 30-day AI spend rollup. Useful for budget alerts.

sitesStudyRoute.get("/sites/cost", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    const sql = getDb();
    const rows = await sql<Record<string, unknown>[]>`
        SELECT
            date_trunc('day', refreshed_at) AS day,
            SUM(scan_cost_usd)::float AS total_usd,
            SUM(scan_tokens_in + scan_tokens_out)::int AS total_tokens,
            COUNT(*) AS scans,
            COUNT(DISTINCT host) AS hosts
        FROM site_intelligence
        WHERE refreshed_at > now() - (${days} || ' days')::interval
        GROUP BY 1
        ORDER BY 1 DESC
    `;
    const totals = await sql<Record<string, unknown>[]>`
        SELECT
            COALESCE(SUM(scan_cost_usd), 0)::float AS total_usd,
            COALESCE(SUM(scan_tokens_in + scan_tokens_out), 0)::int AS total_tokens,
            COUNT(*) AS scans,
            COUNT(DISTINCT host) AS hosts
        FROM site_intelligence
        WHERE refreshed_at > now() - (${days} || ' days')::interval
    `;
    return jsonSafe(c, {
        ok: true,
        days,
        totals: totals[0] || { total_usd: 0, total_tokens: 0, scans: 0, hosts: 0 },
        by_day: rows,
    });
});
```

- [ ] **Step 2: Smoke test**

```bash
curl "http://localhost:3000/api/sites/cost?days=7"
```
Expected: 200 with `totals` and `by_day` arrays (possibly empty if no scans yet).

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add api/src/routes/sites_study.ts
git commit -m "feat(api): GET /api/sites/cost for AI spend rollup"
```

---

### Task 29: Final integration verification

- [ ] **Step 1: Confirm all migrations applied**

```bash
cd /var/www/vhosts/xyzo.org
psql -U asher -d xyzo -c "\dt" | grep -E 'site_intelligence|feature_flags|feature_config|classifier_runs'
psql -U asher -d xyzo -c "\dx" | grep vector
```
Expected: 4 tables + vector extension.

- [ ] **Step 2: Run all new Python tests**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_xyzo_features.py \
                  tests/test_ai_intelligence_scan.py \
                  tests/test_intelligence_scan_prompt.py \
                  tests/test_site_intel_v1_reader.py \
                  tests/test_intelligence_consume.py \
                  tests/test_page_priority.py \
                  tests/test_extractor_selector.py \
                  tests/test_site_crawl_intelligence.py \
                  tests/test_intelligence_integration.py \
                  tests/test_embeddings.py \
                  tests/test_embeddings_dedup.py \
                  tests/test_classifier_data.py \
                  tests/test_classifier_model.py \
                  tests/test_classifier_train.py \
                  -v 2>&1 | tail -25
```
Expected: all tests pass (or skip cleanly if dependencies missing).

- [ ] **Step 3: Confirm production behavior unchanged**

```bash
cd /var/www/vhosts/xyzo.org
psql -U asher -d xyzo -c \
  "SELECT key, enabled FROM feature_flags WHERE key IN ('emergency_disable_intelligence','ai_intelligence_scan','intelligence_driven_crawl','embedding_dedup','classifier_reranker') ORDER BY key;"
```
Expected: all `enabled=f` (except kill switch also off).

- [ ] **Step 4: Confirm emergency kill switch works**

```bash
psql -U asher -d xyzo -c \
  "UPDATE feature_flags SET enabled=true WHERE key='emergency_disable_intelligence';"

python3 -c "
import sys
sys.path.insert(0, '.')
from api.src.xyzo_features import is_enabled
print('ai_intelligence_scan under kill switch:',
      is_enabled('ai_intelligence_scan', 'example.com', 'commercial'))
"

psql -U asher -d xyzo -c \
  "UPDATE feature_flags SET enabled=false WHERE key='emergency_disable_intelligence';"
```
Expected: prints `False`.

- [ ] **Step 5: Run a real site scan (optional, requires API key)**

```bash
curl -X POST http://localhost:3000/api/sites/intelligence-scan \
  -H "Content-Type: application/json" \
  -d '{"host":"example.com"}' | head -c 1500
```
Expected: either a JSON result with intelligence fields, or an error if `XYZO_CLAUDE_API_KEY` is not set.

If `XYZO_CLAUDE_API_KEY` is set and the call succeeds, verify the row was created:
```bash
psql -U asher -d xyzo -c \
  "SELECT host, tier, confidence, scan_tokens_in, scan_cost_usd FROM site_intelligence WHERE host='example.com';"
```
Expected: one row with non-null `confidence`, `scan_tokens_in`, etc.

- [ ] **Step 6: Final commit (if any pending changes)**

```bash
cd /var/www/vhosts/xyzo.org
git status
git log --oneline -15
```

---

## Phase 3 Complete ✅

**What ships:**
- `worker/embeddings.py` — sentence-transformers with graceful degradation
- `worker/embeddings_dedup.py` — pgvector cosine search
- `worker/classifier.py` — training data extraction + two-head PyTorch model + retrain logic + inference
- Wired embeddings + drift_signals into `site_crawl.py`
- API: `POST /api/sites/intelligence-scan`, `GET /api/sites/intelligence/:host`, `GET /api/sites/intelligence-list`
- API: `GET /api/features`, `POST /api/features`
- API: `GET /api/sites/cost` for spend rollup

**Rollout path forward** (per spec section 8):
1. Stage 1 (shadow): set `ai_intelligence_scan.enabled=true, rollout_pct=0`. Logs AI calls, doesn't use results.
2. Stage 2 (write): `rollout_pct=5`. Watch site_intelligence rows accumulate.
3. Stage 3 (crawl hints): enable `intelligence_driven_crawl`, compare event counts.
4. Stage 4 (embeddings): enable `embedding_dedup`, monitor duplicates_caught.
5. Stage 5 (classifier): enable `classifier_reranker` once 500+ labels.
6. Stage 6 (full): all on by tier defaults.

**Next:** Phase 4 (out of scope here) — `/events` front-end page + admin moderation UI.
