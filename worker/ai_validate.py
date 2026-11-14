"""AI validation for community location correction requests.

Called by the API endpoint POST /api/community/requests/:id/ai-validate.
Evaluates whether a user's suggested location is plausible given the
article context.

Usage:
    python -m worker.ai_validate <request_id>
"""
from __future__ import annotations

import json
import logging
import re
import sys

import httpx

from .db import connect
from .extract import _stream_chat, _first_json_block, CHAT_URL, TIMEOUT_S

log = logging.getLogger("xyzo.ai_validate")

VALIDATION_PROMPT = """You are a news geolocation validator. A user says a news story is incorrectly located.

ARTICLE TITLE: {title}
ARTICLE BODY (excerpt): {body}
CURRENT LOCATION: {current_loc}
USER'S SUGGESTION: "{user_suggestion}"
{vote_reasons}

Evaluate whether the user's suggestion is plausible. Consider:
1. Does the article text mention the suggested location?
2. Is the suggested location more relevant than the current one?
3. Are there geographic clues in the article body?

Respond with ONLY a JSON object:
{{
  "valid": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explanation",
  "suggested_place": "best location name if different from user suggestion, or null"
}}"""


def _heuristic_validate(req: dict) -> dict:
    """Non-AI validation for when the AI endpoint is down.

    Two signal sources:
      1. cities_text.stats() on the article — if the user's place is one
         of the cities the engine already recognized, that's a strong
         positive signal.
      2. Substring match of the user's place (and significant words
         from it) against the title + first 500 chars of the body.

    Confidence is bounded [0.0, 1.0] and capped lower than a real AI
    answer so admins don't treat it as gospel.
    """
    from . import cities_text
    import re as _re

    title = (req.get("article_title") or "")
    body = (req.get("article_body") or "")[:500]
    user_place = (req.get("user_place") or "").strip()
    current = (req.get("current_place_name") or "")
    full_text = f"{title}\n{body}"

    if not user_place:
        return {
            "valid": False,
            "confidence": 0.0,
            "reasoning": "no user suggestion provided",
            "suggested_place": None,
            "validated_at": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).isoformat(),
            "method": "heuristic",
        }

    # ── Signal 1: cities in the article ────────────────────────────
    city_match = None
    try:
        stats = cities_text.stats(full_text)
        primary = stats.get("primary") if stats else None
        if primary:
            primary_name = (primary.get("name") or "").lower()
            if primary_name and (
                primary_name in user_place.lower()
                or user_place.lower() in primary_name
            ):
                city_match = primary
    except Exception as e:
        log.debug("heuristic cities_text failed: %s", e)

    # ── Signal 2: token-overlap on user_place ──────────────────────
    place_tokens = [
        t for t in _re.split(r"[\s,]+", user_place.lower()) if len(t) >= 4
    ]
    hits = sum(1 for tok in place_tokens if tok in full_text.lower())

    # ── Decide ─────────────────────────────────────────────────────
    confidence = 0.0
    reasons: list[str] = []
    if city_match:
        confidence += 0.6
        reasons.append(
            f"city scan identified {city_match.get('name')} in article text"
        )
    if hits:
        # Each matching significant token is a soft positive.
        confidence += min(hits * 0.15, 0.5)
        reasons.append(f"{hits} significant token(s) from user_place appear in article")
    if not reasons:
        reasons.append("no textual signal supports the user's suggestion")

    valid = confidence >= 0.4
    reasoning = "Heuristic: " + "; ".join(reasons)

    return {
        "valid": valid,
        "confidence": round(min(confidence, 0.85), 2),
        "reasoning": reasoning[:500],
        "suggested_place": user_place if valid else None,
        "validated_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "method": "heuristic",
    }


def validate_request(request_id: int, *, force_heuristic: bool = False) -> dict:
    """Run AI validation on a single request. Returns the result dict.

    If force_heuristic is True, or if the AI endpoint is down (breaker
    open), or if the AI call raises, falls back to the non-AI
    heuristic. The returned dict always includes `method` so the audit
    trail is honest about who decided.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT r.id, r.pin_id, r.article_id, r.kind, r.user_place,
                   r.community_status, r.result,
                   a.title AS article_title, a.body AS article_body,
                   a.location_text AS current_location,
                   l.place_name AS current_place_name, l.country AS current_country,
                   l.lat AS current_lat, l.lng AS current_lng
            FROM news_re_evaluate_requests r
            LEFT JOIN news_articles a ON a.id = r.article_id
            LEFT JOIN news_locations l ON l.id = a.location_id
            WHERE r.id = %s
            LIMIT 1
        """, (request_id,))
        req = cur.fetchone()

    if not req:
        return {"error": "not_found"}

    # Gather recent votes with reasons.
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT vote, reason FROM news_request_votes
            WHERE request_id = %s AND reason IS NOT NULL AND reason != ''
            ORDER BY created_at DESC LIMIT 5
        """, (request_id,))
        votes = cur.fetchall()

    vote_reasons = ""
    if votes:
        lines = [f"- {v['vote']}: \"{v['reason']}\"" for v in votes]
        vote_reasons = "COMMUNITY VOTES WITH REASONS:\n" + "\n".join(lines)

    article_title = req["article_title"] or "unknown"
    article_body = (req["article_body"] or "")[:1500]
    current_loc = req["current_place_name"]
    if current_loc:
        current_loc = f"{current_loc}, {req['current_country'] or ''} ({req['current_lat']:.3f}, {req['current_lng']:.3f})"
    else:
        current_loc = "unknown"
    user_suggestion = req["user_place"] or "unknown"

    # Breaker-aware: import lazily to avoid a hard dep on extract.py's
    # state when running unit tests.
    if not force_heuristic:
        try:
            from .extract import _ai_call_allowed
            if not _ai_call_allowed():
                log.info("validate_request: AI breaker open, using heuristic for request %d", request_id)
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
        title=article_title,
        body=article_body,
        current_loc=current_loc,
        user_suggestion=user_suggestion,
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
                    "suggested_place": obj.get("suggested_place"),
                    "validated_at": __import__("datetime").datetime.now(
                        __import__("datetime").timezone.utc
                    ).isoformat(),
                    "method": "ai",
                }
            else:
                # Malformed output — don't pretend to know. Fall back.
                log.warning("AI returned unparseable for request %d, using heuristic", request_id)
                try:
                    from .extract import _ai_record_failure
                    _ai_record_failure("malformed_output")
                except ImportError:
                    pass
                result = _heuristic_validate(req)
    except Exception as e:
        log.warning("AI validation failed for request %d: %s — using heuristic", request_id, e)
        try:
            from .extract import _ai_record_failure
            _ai_record_failure(str(e))
        except ImportError:
            pass
        result = _heuristic_validate(req)

    _persist_result(request_id, result)
    return result


def _persist_result(request_id: int, result: dict) -> None:
    """Merge the validation result into the request's result JSONB."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_re_evaluate_requests
            SET result = COALESCE(result, '{}'::jsonb) || %s::jsonb
            WHERE id = %s
        """, (json.dumps({"ai_validation": result}), request_id))
        conn.commit()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print("Usage: python -m worker.ai_validate <request_id> [--heuristic]",
              file=sys.stderr)
        sys.exit(1)
    rid = int(args[0])
    force = "--heuristic" in flags
    out = validate_request(rid, force_heuristic=force)
    print(json.dumps(out, default=str))
