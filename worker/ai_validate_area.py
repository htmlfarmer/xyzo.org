"""AI validation for community area-coverage requests.

Called from ``worker/handlers/community_triage.py`` when the route
enqueues ``op: "ai_validate_area"`` (e.g. on the first confirm vote
in ``api/src/routes/community.ts`` ~line 660). Evaluates whether a
user's request for *more news coverage in a geographic area* looks
legitimate given the optional message and the bbox/zoom/center
context.

Mirrors ``worker.ai_validate`` in shape (heuristic fallback, AI
breaker check, structured prompt, JSON-parsed response, persisted
side-effect) but writes its result to ``news_area_request_replies``
instead of mutating ``news_re_evaluate_requests.result`` JSONB — the
route's ``hasAi.length === 0`` idempotency check relies on a
``reply_type='ai'`` row existing.

Usage (queue handler only — no CLI):
    from worker.ai_validate_area import validate_area_request
    out = validate_area_request(request_id, force_heuristic=False)
"""
from __future__ import annotations

import json
import logging
import re

import httpx

from .db import connect
from .extract import _stream_chat, _first_json_block

log = logging.getLogger("xyzo.ai_validate_area")

VALIDATION_PROMPT = """You are a news-coverage triage validator. A user has asked us to add more news coverage for a specific geographic area (a bbox on the world map).

AREA BBOX: lat [{bbox_min_lat:.4f}, {bbox_max_lat:.4f}], lng [{bbox_min_lng:.4f}, {bbox_max_lng:.4f}]
CENTER: ({center_lat:.4f}, {center_lng:.4f})
MAP ZOOM: {map_zoom}
USER MESSAGE: "{message}"
{vote_reasons}

Evaluate whether this is a legitimate request for more news coverage in this geographic area. Consider:
1. Is the bbox a reasonable size? (Not a single point, not the whole world.)
2. Does the user's message (if any) describe a real geographic region or community?
3. Does the area look like a populated region where local news is plausible?

Respond with ONLY a JSON object:
{{
  "valid": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explanation"
}}"""


def _heuristic_validate(req: dict) -> dict:
    """Non-AI validation for when the AI endpoint is down.

    Signal sources:
      1. bbox plausibility — must be a valid region (not a single point,
         not the whole world, not zero-size).
      2. message keywords — strong region/community cues raise confidence;
         empty message is neutral.

    Confidence is bounded [0.0, 1.0] and capped lower than a real AI
    answer so admins don't treat it as gospel.
    """
    bbox_min_lat = req.get("bbox_min_lat")
    bbox_max_lat = req.get("bbox_max_lat")
    bbox_min_lng = req.get("bbox_min_lng")
    bbox_max_lng = req.get("bbox_max_lng")
    message = (req.get("message") or "").strip()

    confidence = 0.0
    reasons: list[str] = []

    # ── Signal 1: bbox plausibility ─────────────────────────────────
    bbox_ok = False
    try:
        if bbox_min_lat is not None and bbox_max_lat is not None \
                and bbox_min_lng is not None and bbox_max_lng is not None:
            d_lat = float(bbox_max_lat) - float(bbox_min_lat)
            d_lng = float(bbox_max_lng) - float(bbox_min_lng)
            # A reasonable area: > 0.01° in both dimensions, < 60° (not global).
            if 0.01 < d_lat < 60.0 and 0.01 < d_lng < 60.0:
                bbox_ok = True
                confidence += 0.4
                reasons.append(
                    f"bbox spans {d_lat:.2f}° lat × {d_lng:.2f}° lng"
                )
            else:
                reasons.append(
                    f"bbox out of plausible range ({d_lat:.2f}° × {d_lng:.2f}°)"
                )
        else:
            reasons.append("missing bbox coordinates")
    except (TypeError, ValueError):
        reasons.append("invalid bbox coordinates")

    # ── Signal 2: message keywords ──────────────────────────────────
    if message:
        # Region/community keywords raise confidence.
        m_lower = message.lower()
        strong = sum(
            1 for kw in (
                "city", "town", "region", "county", "state", "province",
                "country", "neighborhood", "district", "village", "area",
                "local", "community", "metro", "valley", "island",
            ) if kw in m_lower
        )
        if strong:
            confidence += min(0.3, strong * 0.1)
            reasons.append(f"{strong} region/community keyword(s) in message")
        else:
            # Has a message but no obvious region keywords — neutral.
            confidence += 0.1
            reasons.append("message present but no region keywords detected")
    else:
        # Empty message is neutral; bbox alone is enough to be plausible.
        reasons.append("no message provided; relying on bbox alone")

    if not reasons:
        reasons.append("no signals available")

    valid = confidence >= 0.4
    reasoning = "Heuristic: " + "; ".join(reasons)

    return {
        "valid": valid,
        "confidence": round(min(confidence, 0.85), 2),
        "reasoning": reasoning[:500],
        "validated_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "method": "heuristic",
    }


def validate_area_request(
    request_id: int, *, force_heuristic: bool = False
) -> dict:
    """Run AI validation on a single area-coverage request. Returns the result dict.

    If force_heuristic is True, or if the AI endpoint is down (breaker
    open), or if the AI call raises, falls back to the non-AI
    heuristic. The returned dict always includes `method` so the audit
    trail is honest about who decided.

    On success, persists the result to ``news_area_request_replies``
    with ``reply_type='ai'`` so the route's idempotency check
    (``SELECT 1 FROM news_area_request_replies WHERE request_id=…
    AND reply_type='ai' LIMIT 1``) sees the row on subsequent votes.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng,
                   center_lat, center_lng, map_zoom, message
            FROM news_area_requests
            WHERE id = %s
            LIMIT 1
        """, (request_id,))
        req = cur.fetchone()

    if not req:
        return {"error": "not_found"}

    # Gather recent votes with reasons (mirrors ai_validate pattern).
    vote_reasons = ""
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT vote, reason FROM news_area_request_votes
                WHERE request_id = %s AND reason IS NOT NULL AND reason != ''
                ORDER BY created_at DESC LIMIT 5
            """, (request_id,))
            votes = cur.fetchall()
        if votes:
            lines = [f"- {v['vote']}: \"{v['reason']}\"" for v in votes]
            vote_reasons = "COMMUNITY VOTES WITH REASONS:\n" + "\n".join(lines)
    except Exception as e:
        log.debug("validate_area_request: vote fetch failed: %s", e)

    def _num(v, default=0.0):
        try:
            return float(v) if v is not None else default
        except (TypeError, ValueError):
            return default

    bbox_min_lat = _num(req.get("bbox_min_lat"))
    bbox_max_lat = _num(req.get("bbox_max_lat"))
    bbox_min_lng = _num(req.get("bbox_min_lng"))
    bbox_max_lng = _num(req.get("bbox_max_lng"))
    center_lat = _num(req.get("center_lat"))
    center_lng = _num(req.get("center_lng"))
    map_zoom = req.get("map_zoom")
    map_zoom_s = str(map_zoom) if map_zoom is not None else "unknown"
    message = (req.get("message") or "").strip() or "(no message provided)"

    # Breaker-aware: import lazily to avoid a hard dep on extract.py's
    # state when running unit tests.
    if not force_heuristic:
        try:
            from .extract import _ai_call_allowed
            if not _ai_call_allowed():
                log.info(
                    "validate_area_request: AI breaker open, using heuristic for request %d",
                    request_id,
                )
                result = _heuristic_validate(req)
                _persist_result(request_id, result)
                return result
        except ImportError:
            pass

    if force_heuristic:
        result = _heuristic_validate(req)
        _persist_result(request_id, result)
        return result

    prompt = VALIDATION_PROMPT.format(
        bbox_min_lat=bbox_min_lat,
        bbox_max_lat=bbox_max_lat,
        bbox_min_lng=bbox_min_lng,
        bbox_max_lng=bbox_max_lng,
        center_lat=center_lat,
        center_lng=center_lng,
        map_zoom=map_zoom_s,
        message=message,
        vote_reasons=vote_reasons,
    )

    # Call the AI.
    try:
        with httpx.Client() as client:
            raw = _stream_chat(client, prompt)
            obj = _first_json_block(raw)
            if obj and "valid" in obj:
                result = {
                    "valid": bool(obj["valid"]),
                    "confidence": float(obj.get("confidence", 0)),
                    "reasoning": str(obj.get("reasoning", ""))[:500],
                    "validated_at": __import__("datetime").datetime.now(
                        __import__("datetime").timezone.utc
                    ).isoformat(),
                    "method": "ai",
                }
            else:
                # Malformed output — don't pretend to know. Fall back.
                log.warning(
                    "AI returned unparseable for area request %d, using heuristic",
                    request_id,
                )
                try:
                    from .extract import _ai_record_failure
                    _ai_record_failure("malformed_output")
                except ImportError:
                    pass
                result = _heuristic_validate(req)
    except Exception as e:
        log.warning(
            "AI validation failed for area request %d: %s — using heuristic",
            request_id, e,
        )
        try:
            from .extract import _ai_record_failure
            _ai_record_failure(str(e))
        except ImportError:
            pass
        result = _heuristic_validate(req)

    _persist_result(request_id, result)
    return result


def _persist_result(request_id: int, result: dict) -> None:
    """Insert the AI result into ``news_area_request_replies``.

    Uses ``reply_type='ai'`` so the route's
    ``SELECT 1 FROM news_area_request_replies WHERE request_id=…
    AND reply_type='ai' LIMIT 1`` idempotency check sees the row on
    subsequent confirm votes. ``reply_text`` carries the reasoning,
    ``metadata`` carries the full result dict for downstream readers.
    """
    reply_text = (
        f"AI validation: valid={result.get('valid')}, "
        f"confidence={result.get('confidence')}. "
        f"{result.get('reasoning', '')}"
    )[:1000]

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO news_area_request_replies
                (request_id, reply_type, reply_text, metadata, created_at)
            VALUES (%s, 'ai', %s, %s::jsonb, now())
            """,
            (
                request_id,
                reply_text,
                json.dumps(result),
            ),
        )
        conn.commit()
