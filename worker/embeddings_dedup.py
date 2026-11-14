"""embeddings_dedup — pgvector cosine search for cross-source dedup.

Pipeline:
  encode_event(event) -> 384-dim vector
  find_near_duplicates(event_id, vector, starts_at) -> list of matches

Matches within ±1 day of ``starts_at`` with similarity above the review
band are returned. Each match is tagged with a ``band``:

  - ``"auto"``   — ``sim >= DEFAULT_THRESHOLD`` (0.92). Caller may
                    auto-merge subject to the gov / university guard.
  - ``"review"`` — ``REVIEW_THRESHOLD_LOWER <= sim < DEFAULT_THRESHOLD``
                    (0.85 .. 0.92). Caller should queue for human
                    review; do not auto-merge silently.
  - below ``REVIEW_THRESHOLD_LOWER`` — filtered out, never returned.

The caller decides what to do with ``"review"`` band matches.

Standing constraint (gov / university protection):
  Auto-merging two events whose source tiers are BOTH ``gov`` or
  ``university`` is forbidden — those events must be queued for manual
  review instead. ``mark_duplicate`` accepts ``source_tier`` and
  ``target_tier`` kwargs to enable the guard. When neither tier is
  supplied the protection is a no-op. Callers must supply both tiers to
  enable the gov/university guard; missing tier is logged with a
  WARNING so operators see the unprotected merge.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("xyzo.embeddings_dedup")

#: Cosine similarity above which we auto-merge.
DEFAULT_THRESHOLD = 0.92

#: Lower bound of the review band. Matches in (REVIEW_THRESHOLD_LOWER,
#: DEFAULT_THRESHOLD) are tagged ``band="review"``; matches below this
#: are filtered out and never returned. Pinned at the spec default of
#: 0.85.
REVIEW_THRESHOLD_LOWER = 0.85

#: Tiers whose events must never be auto-merged silently when BOTH
#: sides are protected. Spec calls out gov / university; commercial
#: and community events may merge freely.
_PROTECTED_TIERS = frozenset({"gov", "university"})


def _connect():
    """Lazy-import the worker-local ``db`` helper. Keeps this module
    importable without DB env vars or a live pool."""
    from db import connect  # type: ignore
    return connect()


def _search(vector_str: str, starts_at: str | None,
            threshold: float, limit: int) -> list[dict]:
    """Run the cosine search query. Returns [] on any DB error."""
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
            return [
                {"id": r["id"], "title": r["title"],
                 "sim": float(r["sim"]), "source_url": r["source_url"]}
                for r in rows
            ]
    except Exception as e:
        log.warning("dedup search failed: %s", e)
        return []


def _execute(sql: str, *params) -> None:
    """Run a write against the DB. Swallows exceptions so callers
    never crash on dedup writes."""
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()
    except Exception as e:
        log.warning("dedup execute failed: %s", e)


def find_near_duplicates(
    event_id: Any,
    vector: list[float],
    starts_at: str | None = None,
    threshold: float = DEFAULT_THRESHOLD,
    limit: int = 5,
) -> list[dict]:
    """Return near-duplicate events sorted by similarity desc.

    Excludes the input ``event_id`` from the results (it must never
    match itself). An empty ``vector`` short-circuits to ``[]`` without
    touching the DB. ``_search`` already handles DB errors and returns
    ``[]``; that empty list propagates as-is.

    Each returned dict carries a ``band`` key:

      - ``"auto"``   — ``sim >= DEFAULT_THRESHOLD`` (above auto-merge
                        threshold)
      - ``"review"`` — ``REVIEW_THRESHOLD_LOWER <= sim < DEFAULT_THRESHOLD``
                        (above noise floor but below auto-merge)

    Matches below ``REVIEW_THRESHOLD_LOWER`` are filtered out (noise)
    and never returned.
    """
    if not vector:
        return []
    # pgvector expects '[v1,v2,...]' — no spaces, comma separators.
    vector_str = "[" + ",".join(str(float(v)) for v in vector) + "]"
    matches = _search(vector_str, starts_at, threshold, limit)
    out: list[dict] = []
    for m in matches:
        if m["id"] == event_id:
            continue
        if m["sim"] < REVIEW_THRESHOLD_LOWER:
            # Below noise floor — caller doesn't want to see these.
            continue
        band = "auto" if m["sim"] >= DEFAULT_THRESHOLD else "review"
        out.append({**m, "band": band})
    return out[:limit]


def mark_duplicate(
    lower_id: int,
    higher_id: int,
    source_tier: str | None = None,
    target_tier: str | None = None,
) -> None:
    """Mark an event as a duplicate of another (writes ``merged_into``).

    ID / tier semantics (must match exactly across the codebase):

      lower_id = the event being subsumed. Its ``merged_into``
                 column is updated to point at ``higher_id``.
      higher_id = the canonical event that is KEPT. All other
                 data on this row stays intact.

      source_tier = tier of the lower_id event (the one being
                   retired).
      target_tier = tier of the higher_id event (the one being
                   kept).

    Tier-protection (gov / university): if BOTH ``source_tier`` and
    ``target_tier`` resolve to ``gov`` or ``university``, the merge is
    REFUSED — those events must be reviewed by a human. A WARNING is
    logged so the caller can see the skip.

    When only one side is protected (or neither tier is provided), the
    merge proceeds and a WARNING is logged naming the missing tier(s).
    Both tiers must be supplied to enable the gov / university guard;
    missing tier is logged and the merge proceeds (gov / university
    protection is the caller's responsibility). The DB write itself
    goes through ``_execute``, which already swallows exceptions.
    """
    if (source_tier in _PROTECTED_TIERS
            and target_tier in _PROTECTED_TIERS):
        log.warning(
            "refusing auto-merge of protected-tier events: "
            "lower_id=%s higher_id=%s source_tier=%s target_tier=%s "
            "(gov/university events must be reviewed manually)",
            lower_id, higher_id, source_tier, target_tier,
        )
        return
    # If a tier is missing on either side we can't actually run the
    # gov/university guard — surface that loudly so operators notice
    # silent unprotected merges.
    if source_tier is None or target_tier is None:
        log.warning(
            "mark_duplicate missing tier info — gov/university "
            "guard DISABLED for this merge: lower_id=%s higher_id=%s "
            "source_tier=%r target_tier=%r "
            "(caller must supply both tiers to enable protection)",
            lower_id, higher_id, source_tier, target_tier,
        )
    # Outer try/except is kept intentionally: ``_execute`` swallows
    # DB errors, but a buggy or mocked ``_execute`` could still raise.
    # The dedup write path is best-effort — the caller must never
    # crash on dedup.
    try:
        _execute(
            "UPDATE crawl_events SET merged_into = %s WHERE id = %s",
            higher_id, lower_id,
        )
    except Exception as e:
        log.warning("mark_duplicate failed for lower=%s higher=%s: %s",
                    lower_id, higher_id, e)