"""Notify the xyzo API when an article is inserted.

The API runs an in-process pub/sub that fans out Server-Sent Events to
every connected /feed/live/stream client. To make new articles appear
within seconds (instead of waiting for the client's 30-second poll),
the worker POSTs to /api/internal/article-created after a successful
INSERT into news_articles.

Auth: shared secret via the X-Internal-Key header. The same env var
(XYZO_INTERNAL_KEY) must be set on both worker and API; if it's
unset the API refuses every call (fail-closed).

Failure mode: this is best-effort. A 5xx, timeout, or DNS error must
NOT fail the worker — the article is already in the DB and the SSE
snapshot safety net (60-second resync on the API side) will pick it
up. We log the failure and move on.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

import httpx

log = logging.getLogger(__name__)

# Tunables: keep the request short — the worker has a queue to keep
# moving. 2 seconds is enough for localhost; LAN should be sub-100ms.
_TIMEOUT_S = 2.0

# NLP processing flag - set to True to trigger NLP on new articles
_NLP_ENABLED = os.environ.get("XYZO_NLP_ON_FETCH", "").lower() in ("1", "true", "yes")


def _get_api_url() -> str | None:
    """Resolve the API base URL from env. None = notify disabled."""
    url = os.environ.get("XYZO_API_URL") or os.environ.get("NEWSIUM_API_URL")
    if not url:
        return None
    return url.rstrip("/")


def _get_internal_key() -> str | None:
    key = os.environ.get("XYZO_INTERNAL_KEY") or os.environ.get("NEWSIUM_INTERNAL_KEY")
    return key or None


# One client per worker process. Reusing the client reuses the
# connection pool and TLS session (when applicable), which makes the
# per-call overhead negligible.
_client_lock = threading.Lock()
_client: httpx.Client | None = None


def _get_client() -> httpx.Client | None:
    global _client
    base = _get_api_url()
    if not base:
        return None
    with _client_lock:
        if _client is None:
            _client = httpx.Client(base_url=base, timeout=_TIMEOUT_S)
    return _client


def notify_article_created(article: dict[str, Any]) -> None:
    """Best-effort POST to the API. Never raises.

    The caller is the worker's INSERT path — we MUST NOT propagate
    network errors back up, because the article is already in the DB
    and the SSE safety-net resync will catch the missed notification.
    """
    key = _get_internal_key()
    client = _get_client()
    if not key or client is None:
        # API_URL or KEY not configured — skip silently. The deploys
        # that run worker without an API (rare) keep working.
        return
    try:
        # Trim to the fields the API schema accepts. The worker row
        # has ~30 columns; sending all of them would balloon the
        # broadcast payload and the schema would reject unknown keys.
        payload = {
            "id": int(article["id"]),
            "title": str(article.get("title") or "")[:500],
            "status": article.get("status"),
            "source_id": article.get("source_id"),
            "published_at": (
                article["published_at"].isoformat()
                if hasattr(article.get("published_at"), "isoformat")
                else article.get("published_at")
            ),
        }
        for opt in ("url", "summary", "lat", "lng", "image_url"):
            if opt in article and article[opt] is not None:
                payload[opt] = str(article[opt])[:2000] if opt in ("url", "image_url") else article[opt]
        client.post(
            "/api/internal/article-created",
            json=payload,
            headers={"x-internal-key": key},
        )
    except Exception as e:  # noqa: BLE001 — best-effort, never raise
        log.warning("notify_article_created failed: %s", e)


def trigger_nlp_processing(article_id: int) -> None:
    """Trigger NLP extraction for a newly inserted article.

    This runs in a background thread to avoid blocking the fetch worker.
    NLP extraction processes 6 feature types:
    - Temporal (dates, past/present/future)
    - Quantities (money, percentages, counts)
    - Entities (persons, organizations, locations)
    - Claims (subject-predicate-object triples)
    - Attribution (source types: official/expert/witness)
    - Linguistic (entropy, type/token ratio, n-grams)
    """
    if not _NLP_ENABLED:
        return

    def _do_nlp():
        try:
            from .db import connect
            from .extract_nlp import extract_all_features

            with connect() as conn:
                row = conn.execute("""
                    SELECT id, title, summary, body
                    FROM news_articles
                    WHERE id = %s
                """, (article_id,)).fetchone()

            if not row:
                return

            features = extract_all_features(row['id'], row['title'], row['summary'], row['body'])

            import json
            with connect() as conn:
                conn.execute("""
                    INSERT INTO article_facts (
                        article_id,
                        temporal_features,
                        quantity_features,
                        entity_features,
                        claim_features,
                        attribution_features,
                        linguistic_features
                    )
                    VALUES (%s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)
                    ON CONFLICT (article_id) DO UPDATE SET
                        temporal_features = COALESCE(EXCLUDED.temporal_features, article_facts.temporal_features),
                        quantity_features = COALESCE(EXCLUDED.quantity_features, article_facts.quantity_features),
                        entity_features = COALESCE(EXCLUDED.entity_features, article_facts.entity_features),
                        claim_features = COALESCE(EXCLUDED.claim_features, article_facts.claim_features),
                        attribution_features = COALESCE(EXCLUDED.attribution_features, article_facts.attribution_features),
                        linguistic_features = COALESCE(EXCLUDED.linguistic_features, article_facts.linguistic_features)
                """, (
                    article_id,
                    json.dumps(features['temporal_features']),
                    json.dumps(features['quantity_features']),
                    json.dumps(features['entity_features']),
                    json.dumps(features['claim_features']),
                    json.dumps(features['attribution_features']),
                    json.dumps(features['linguistic_features']),
                ))
            log.debug("NLP processed article %d", article_id)
        except Exception as e:
            log.warning("NLP processing failed for article %d: %s", article_id, e)

    thread = threading.Thread(target=_do_nlp, daemon=True)
    thread.start()
