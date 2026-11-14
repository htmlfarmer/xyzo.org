"""Queue-callable handler for the ``links_generate`` job kind.

Runs two link detection passes:

  1. ``worker.story_linker.run`` — the 3-pass linker:
     * Pass 1: Geo-proximity & cross-language (same city/25km, 72h window)
     * Pass 2: Keyword & entity overlap via word_freq inverted index
     * Pass 3: Neural embedding cosine via pgvector ANN search
     Writes results to ``news_story_links``.

  2. ``worker.links.detect_links_batch`` — supplemental simple linker
     (same_city, same_country, same_event, word_overlap) for articles
     the story_linker may miss due to its stricter time/geo windows.

Both write to ``news_story_links`` with ON CONFLICT DO NOTHING so they
don't duplicate each other.

Payload shape
-------------
limit : int (default 500) — number of recent articles to scan.
"""
from __future__ import annotations

import logging
from typing import Any

from worker.links import detect_links_batch
from worker.story_linker import run as story_linker_run

log = logging.getLogger("xyzo.links_generate")


def run(payload: dict[str, Any], ctx) -> dict[str, Any]:
    """Dispatcher's entry point for the ``links_generate`` kind."""
    ctx.check_cancel()

    raw_limit = payload.get("limit", 500)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        raise ValueError(
            f"links_generate payload requires numeric limit, got {raw_limit!r}"
        )

    # ── Pass A: 3-pass story linker (geo + keyword + embeddings) ────
    story_result = {"links_found": 0, "links_stored": 0}
    try:
        story_result = story_linker_run(days=3, limit=limit, dry_run=False)
        log.info("links_generate: story_linker found=%d stored=%d",
                 story_result.get("links_found", 0),
                 story_result.get("links_stored", 0))
    except Exception as e:
        log.warning("links_generate: story_linker failed: %s", e)

    ctx.check_cancel()

    # ── Pass B: simple linker (same_city, same_country, same_event) ─
    simple_result = {"processed": 0, "links_created": 0, "links_skipped": 0}
    try:
        simple_result = detect_links_batch(limit=limit)
        log.info("links_generate: simple_linker processed=%d created=%d skipped=%d",
                 simple_result.get("processed", 0),
                 simple_result.get("links_created", 0),
                 simple_result.get("links_skipped", 0))
    except Exception as e:
        log.warning("links_generate: simple_linker failed: %s", e)

    return {
        "story_linker": story_result,
        "simple_linker": simple_result,
        "processed": simple_result.get("processed", 0),
        "links_created": (
            story_result.get("links_stored", 0)
            + simple_result.get("links_created", 0)
        ),
        "links_skipped": simple_result.get("links_skipped", 0),
    }