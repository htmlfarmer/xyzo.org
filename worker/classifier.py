"""classifier — two-head NN for URL event-richness + event type.

Two heads on shared sentence-transformers backbone:
  - re-ranker: sigmoid output 0..1 (how likely this URL surfaces events)
  - event-type: softmax over 8 classes

Bootstraps from discovered_pages labels. Retrains weekly or when
new_samples > retrain_min_samples (default 500).

Deviation from spec (gov / university protection)
-------------------------------------------------
The plan does NOT mention tier filtering for the training set. We add
``WHERE si.tier NOT IN ('gov','university')`` to ``_query_training_data``
because the standing project constraint requires that gov / university
sources never become the basis for derived signals. The classifier is a
derived signal that, once trained, would steer future crawl decisions
(frontier scoring, page_priority weights, etc.) — training it on
protected-tier events would let those decisions leak back into
crawl-pressure on gov / university hosts. Filtering at the source is
safer than filtering at inference time. Hosts with no
``site_intelligence`` row yet (the table is freshly added) flow
through with ``si.tier IS NULL`` so the model still sees unscanned
commercial / community data — the common case during Phase 3 rollout.

Read-only: this module never writes to the DB. Embeddings are computed
lazily by the training loop (sentence-transformers is expensive and
must be batched), so ``TrainingSample.embedding`` is always ``None``
when returned from ``fetch_training_samples``.
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


# Tiers excluded from the training set. See module docstring.
_EXCLUDED_TIERS = ("gov", "university")


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
    """Convert event counts + signals into a 0..1 richness label.

    Bands:
      n_events>0   → up to +0.8 (saturates at 5 events)
      has_jsonld   → +0.1
      has_heuristic→ +0.5
    Capped at 1.0. The coefficients were tuned so that a typical
    heuristic-only RSS page sits in the [0.4, 0.7] band (medium)
    while a JSON-LD-rich page breaks past 0.8.
    """
    score = 0.0
    if n_events > 0:
        score += min(n_events / 5.0, 0.8)   # saturate at 5 events
    if has_jsonld:
        score += 0.1
    if has_heuristic:
        score += 0.5
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
    """Read labeled pages from discovered_pages.

    Joins:
      discovered_pages    — per-page findings (URL, json_ld, signals)
      site_crawl_results  — finished_at window
      site_intelligence   — host tier, used to filter out gov / university

    Returns ``[]`` on any DB error (the worker must never crash on
    classifier data fetches). Rows are returned with a ``tier`` key so
    ``fetch_training_samples`` can do a final defensive filter (the
    ``fetch_training_samples`` call below also drops protected tiers
    in case a future caller swaps the SQL out).
    """
    try:
        from db import connect  # type: ignore
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    dp.url,
                    dp.json_ld_events,
                    dp.heuristic_events,
                    dp.signals,
                    si.tier AS tier
                FROM discovered_pages dp
                JOIN site_crawl_results sc ON sc.id = dp.crawl_id
                LEFT JOIN site_intelligence si ON si.host = sc.host
                WHERE sc.finished_at > now() - (%s || ' days')::interval
                  AND (si.tier IS NULL OR si.tier NOT IN ('gov','university'))
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

    Defence-in-depth: even though ``_query_training_data`` filters at
    the SQL level, we also drop any row whose ``tier`` field is in
    ``_EXCLUDED_TIERS``. This guards against a future caller swapping
    the SQL (or unit tests passing pre-filtered rows that bypass the
    SQL filter). A WARNING is logged so operators notice the filter.

    Swallows any DB exception and returns ``[]`` so the training
    scheduler is never blocked by a transient outage.
    """
    try:
        rows = _query_training_data(since_days)
    except Exception as e:
        log.warning("fetch_training_samples: query raised: %s", e)
        return []

    out: list[TrainingSample] = []
    dropped = 0
    for r in rows:
        tier = (r.get("tier") or "").lower()
        if tier in _EXCLUDED_TIERS:
            dropped += 1
            continue

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
    if dropped:
        log.warning(
            "fetch_training_samples dropped %d gov/university rows "
            "(standing constraint: protected-tier events never enter "
            "classifier training data)", dropped,
        )
    return out


# ── Model definition (Task 22) ──────────────────────────────────────
#
# Two heads on a shared MLP backbone fed by sentence-transformer
# embeddings (384-dim, all-MiniLM-L6-v2). The re-ranker head is a
# sigmoid output in [0, 1] — "how likely this URL surfaces events".
# The event-type head is a softmax over 8 classes.
#
# Lazy torch import: training/inference code that only needs
# ``fetch_training_samples`` (e.g. weekly retrain scheduler) must be
# importable without torch. We follow the same pattern used by
# ``worker/embeddings.py`` — import inside the function that needs it.

CLASSIFIER_CONFIG = {
    "input_dim": 384,
    "hidden_dims": [128, 64],
    "dropout": 0.3,
    "reranker_head": 1,
    "event_type_classes": 8,
}


def build_model():
    """Build a fresh ``TwoHeadClassifier`` instance.

    The torch import is intentionally local so that this module stays
    importable on machines without torch (e.g. the lint job, or the
    training-data fetcher before the model is needed).
    """
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
            self.event_type_head = nn.Linear(
                in_dim, cfg["event_type_classes"],
            )

        def forward(self, x):
            features = self.backbone(x)
            reranker = torch.sigmoid(self.reranker_head(features))
            event_type = torch.softmax(
                self.event_type_head(features), dim=-1,
            )
            return reranker, event_type

        def _test_forward(self):
            # Local torch import keeps this method callable even when
            # build_model was imported without resolving torch first.
            import torch as _torch
            dummy = _torch.zeros(1, cfg["input_dim"])
            return self.forward(dummy)

    return TwoHeadClassifier()


def load_latest_model():
    """Stub: load the most recent ok classifier from disk.

    Implemented in a later task (Task 24). For now this returns
    ``None`` so callers can treat "no trained model yet" as a
    no-op without try/except. Returning ``None`` (not raising)
    matches the spec's test which accepts either a returned model
    or any exception during load.
    """
    return None
