"""Stage-2 deep moderation for community-submitted pins (op=moderate_pin).

Runs under the ``community_triage`` queue kind, enqueued fire-and-forget
by ``POST /api/pins`` AFTER the synchronous fast scan (api/src/lib/
quickmod.ts) already published the pin. Never blocks a user request;
every step is best-effort and individually failure-isolated.

Pipeline (cheapest → most expensive, LLM last and only if free):

  1. Load the pin + community_details.
  2. ``word_freq.extract_word_freq_extended`` — language detection,
     doc_type genre classification, top-word frequency analysis.
  3. Coordinate sanity vs ``spatial.ne_countries`` — flags ocean clicks
     (the fast path can't afford a point-in-polygon check).
  4. If a canonical_url was submitted: robots.txt verdict, bounded
     (8 MB) fetch via ``fetch._bounded_get``, text extraction, and
     frequency analysis of the PAGE — this is the context the LLM gets
     instead of trusting the user's description alone.
  5. LLM verdict — ONLY when ``extract._ai_call_allowed()`` (the shared
     circuit breaker) says the AI box is free. Strict-JSON, one short
     paragraph reason, 12 s ceiling. Breaker open / timeout / malformed
     output → skip gracefully (mod_status='deep_ok_no_llm'); the pin
     stays published under its stage-1 verdict.
  6. Persist everything to ``community_details.mod_deep`` (JSONB audit
     trail). LLM says not-ok → ``pins.status='hidden'`` +
     mod_status='rejected' (recoverable by an admin flipping status).

Design notes:
  * MINIMIZES LLM SPEND: the queue soft-caps concurrency (2 running),
    the breaker short-circuits when the box is busy/down, and pins that
    already failed stage 1 never get here at all.
  * No new HTTP client abstractions — reuses extract.py's CHAT_URL /
    SAFE_HEADERS and fetch.py's bounded GET so memory + redirect caps
    stay identical to the ingestion fleet.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import httpx

from .db import connect

log = logging.getLogger("xyzo.pin_moderate")

# Shorter than the 25 s extraction timeout — moderation is a small prompt
# and the queue kind ceiling is 60 s. Slow box → skip, don't wait.
MODERATE_TIMEOUT_S = float(os.environ.get("XYZO_MODERATE_TIMEOUT_S", "12"))

# Categories the LLM may suggest — must stay inside the pins_category_check
# constraint (schema-icons.sql): the 12 main buckets + the finer sub-types.
VALID_CATEGORIES = {
    # Main buckets
    "politics", "business", "crime", "weather", "science", "technology",
    "sports", "culture", "environment", "conflict", "health", "other",
    # Politics sub-types
    "elections", "courts", "policy", "diplomacy", "protest",
    # Business sub-types
    "markets", "banking", "crypto", "realestate", "labor",
    # Crime / safety sub-types
    "shooting", "terrorism", "cybercrime", "missing", "traffic",
    # Weather sub-types
    "storm", "floods", "wildfire", "drought", "snow", "heatwave",
    # Science sub-types
    "space", "biology", "physics", "research",
    # Technology sub-types
    "ai", "cybersecurity", "gaming", "telecom",
    # Sports sub-types
    "soccer", "basketball", "olympics", "racing",
    # Culture sub-types
    "music", "film", "art", "books",
    # Environment sub-types
    "climate", "wildlife", "pollution", "energy",
    # Health sub-types
    "outbreak", "medical", "mental_health",
    # Conflict / disaster sub-types
    "war", "military", "earthquake", "volcano", "refugees", "aid",
    # Local & global interest sub-types
    "education", "food", "transit", "festivals", "religion", "housing",
    "automotive", "trade",
}

MODERATION_PROMPT = """You are a news-map submission moderator. A user pinned a story idea to a map.
Decide if it is a legitimate news story / story idea for that location.

REJECT only for: advertising or spam, scams, adult content, harassment or
slurs, deliberate nonsense, or content with no conceivable news value.
Everything else — including vague, emotional, or unverified local reports —
is OK (humans review later).

Submission:
title: {title}
note: {note}
coordinates: {lat}, {lng}{country_note}
automated pre-check signals: {signals}
detected language: {lang} doc_type: {doc_type}
{url_section}
Respond with ONLY this JSON object:
{{"ok": true|false, "topic": "<=12 word summary of what this is about", "category": "one of: politics business crime weather science technology sports culture environment conflict health earthquake other", "reason": "<=60 words, one short paragraph"}}"""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_pin(pin_id: int) -> dict | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.title, p.category, p.status,
                   ST_Y(p.location::geometry) AS lat,
                   ST_X(p.location::geometry) AS lng,
                   cd.story_note, cd.canonical_url, cd.mod_fast, cd.mod_status
            FROM pins p
            LEFT JOIN community_details cd ON cd.pin_id = p.id
            WHERE p.id = %s AND p.source_type = 'community'
            LIMIT 1
            """,
            (pin_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def _country_at(lat: float, lng: float) -> str | None:
    """Point-in-country via Natural Earth polygons (ocean → None).

    spatial.ne_countries lives in the SEPARATE xyzo_cities database (same
    DSN worker/validate_cities.py uses), not the main xyzo DB. Best-effort:
    any unavailability degrades to None without failing moderation.
    """
    try:
        import psycopg

        dsn = os.environ.get(
            "XYZO_CITIES_DB_DSN",
            "postgresql://cities_writer:CHANGE_ME@localhost:5432/xyzo_cities",
        )
        with psycopg.connect(dsn, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT iso_a2 FROM spatial.ne_countries
                    WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                    LIMIT 1
                    """,
                    (lng, lat),
                )
                row = cur.fetchone()
        return row[0] if row else None
    except Exception as exc:  # missing db/table/extension — never fatal
        log.debug("country check unavailable: %s", exc)
        return None


def _analyze_text(title: str, note: str) -> dict:
    """word_freq extended analysis: language, genre, frequency profile."""
    try:
        from .word_freq import extract_word_freq_extended

        ext = extract_word_freq_extended(title, note or "", max_words=25)
        return {
            "lang": ext.get("detected_lang"),
            "doc_type": ext.get("doc_type"),
            "doc_type_confidence": ext.get("doc_type_confidence"),
            "top_words": ext.get("top_words", {}),
        }
    except Exception as exc:
        log.warning("text analysis failed for submission: %s", exc)
        return {"lang": None, "doc_type": None, "top_words": {}, "error": str(exc)}


def _check_url(url: str) -> dict:
    """robots.txt verdict + bounded fetch + frequency analysis of the page.

    Mirrors the ingestion fleet's constraints: MAX_FEED_BYTES stream cap,
    6-redirect ceiling, robots checked BEFORE any request.
    """
    out: dict = {"url": url, "robots": None, "fetched": False}
    try:
        from .robots import RobotsCache
        from .fetch import _bounded_get, user_agent_for
        from .web_scraper import _extract_article

        robots = RobotsCache(ua=user_agent_for(url))
        verdict = robots.is_allowed(url)
        out["robots"] = {
            "allowed": bool(verdict.allowed),
            "note": getattr(verdict, "note", None),
            "crawl_delay_s": getattr(verdict, "crawl_delay_s", None),
        }
        if not verdict.allowed:
            return out

        with httpx.Client(follow_redirects=True, max_redirects=6) as client:
            status, _headers, body = _bounded_get(
                client, url,
                {"User-Agent": user_agent_for(url),
                 "Accept": "text/html,application/xhtml+xml"},
            )
        out["http_status"] = status
        if body is None:
            return out
        out["fetched"] = True
        out["bytes"] = len(body)

        article = _extract_article(body.decode("utf-8", "replace"), url)
        if article:
            out["page_title"] = (article.get("title") or "")[:300]
            text = (article.get("body") or "")[:6000]
            from .word_freq import extract_word_freq_extended

            ext = extract_word_freq_extended(out["page_title"], text, max_words=25)
            out["page_lang"] = ext.get("detected_lang")
            out["page_doc_type"] = ext.get("doc_type")
            out["page_top_words"] = ext.get("top_words", {})
    except Exception as exc:
        out["error"] = str(exc)[:200]
        log.info("url check failed for %s: %s", url, exc)
    return out


def _llm_verdict(pin: dict, text_info: dict, url_info: dict | None,
                 country: str | None) -> dict | None:
    """Breaker-gated LLM check. Returns None when skipped (busy/down/slow)."""
    try:
        from .extract import (CHAT_URL, SAFE_HEADERS, _ai_call_allowed,
                              _ai_record_failure, _first_json_block)
    except ImportError as exc:
        log.warning("extract.py import failed; skipping LLM stage: %s", exc)
        return None

    if not _ai_call_allowed():
        log.info("moderate_pin %s: AI breaker open — skipping LLM", pin["id"])
        return None

    mod_fast = pin.get("mod_fast") or {}
    if isinstance(mod_fast, str):
        try:
            mod_fast = json.loads(mod_fast)
        except json.JSONDecodeError:
            mod_fast = {}

    url_section = ""
    if url_info:
        bits = [f"submitted url robots-allowed: {url_info.get('robots', {}).get('allowed')}",
                f"url fetch status: {url_info.get('http_status')}"]
        if url_info.get("page_title"):
            bits.append(f"page title: {url_info['page_title']}")
        if url_info.get("page_top_words"):
            top = sorted(url_info["page_top_words"].items(),
                         key=lambda kv: -kv[1])[:12]
            bits.append("page word frequencies: " + ", ".join(f"{w}:{n}" for w, n in top))
        url_section = "\n".join(bits)

    prompt = MODERATION_PROMPT.format(
        title=(pin.get("title") or "")[:300],
        note=(pin.get("story_note") or "")[:1500] or "(none)",
        lat=round(float(pin["lat"]), 4), lng=round(float(pin["lng"]), 4),
        country_note=f" (country polygon: {country})" if country else " (OCEAN — no country polygon contains this point)",
        signals=", ".join((mod_fast.get("signals") or [])[:10]) or "(none)",
        lang=text_info.get("lang") or "unknown",
        doc_type=text_info.get("doc_type") or "unknown",
        url_section=url_section or "(no url submitted)",
    )

    try:
        # The local chat endpoint speaks SSE (data: {choices:[{delta:...}]}
        # lines, terminated by [DONE]) and takes {"message": str, "stream":
        # bool} — same wire protocol as extract._stream_chat, but with OUR
        # moderation prompt (extract's version hard-prepends the article-
        # extraction system prompt, which would fight the verdict schema).
        raw = ""
        done = False
        with httpx.Client(timeout=MODERATE_TIMEOUT_S) as client:
            with client.stream(
                "POST", CHAT_URL,
                json={"message": prompt, "stream": True},
                headers=SAFE_HEADERS,
            ) as resp:
                resp.raise_for_status()
                buf = ""
                for chunk in resp.iter_text():
                    if done or not chunk:
                        continue
                    buf += chunk
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        payload_str = line[5:].strip()
                        if payload_str == "[DONE]":
                            done = True
                            break
                        try:
                            obj = json.loads(payload_str)
                        except json.JSONDecodeError:
                            continue
                        delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if delta:
                            raw += delta
        obj = _first_json_block(raw)
        if not obj or "ok" not in obj:
            log.warning("moderate_pin %s: unparseable LLM output", pin["id"])
            _ai_record_failure("moderate_pin_malformed")
            return None
        category = str(obj.get("category") or "").strip().lower()
        return {
            "ok": bool(obj["ok"]),
            "topic": str(obj.get("topic") or "")[:200],
            "category": category if category in VALID_CATEGORIES else None,
            "reason": str(obj.get("reason") or "")[:600],
            "at": _utcnow(),
        }
    except Exception as exc:
        log.info("moderate_pin %s: LLM call failed (%s) — skipping", pin["id"], exc)
        try:
            _ai_record_failure(f"moderate_pin:{exc}"[:120])
        except Exception:
            pass
        return None


def _persist(pin_id: int, mod_deep: dict, mod_status: str, *,
             hide: bool = False, new_category: str | None = None) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE community_details SET mod_deep = %s::jsonb, mod_status = %s "
            "WHERE pin_id = %s",
            (json.dumps(mod_deep, default=str), mod_status, pin_id),
        )
        if hide:
            cur.execute(
                "UPDATE pins SET status = 'hidden' WHERE id = %s AND source_type = 'community'",
                (pin_id,),
            )
        if new_category:
            cur.execute(
                "UPDATE pins SET category = %s WHERE id = %s AND source_type = 'community'",
                (new_category, pin_id),
            )
        conn.commit()


def moderate_pin(pin_id: int, *, user_category: str | None = None) -> dict:
    """Deep-check one community pin. Returns the mod_deep dict (also persisted)."""
    pin = _load_pin(pin_id)
    if pin is None:
        return {"error": "pin_not_found", "pin_id": pin_id, "at": _utcnow()}

    title = pin.get("title") or ""
    note = pin.get("story_note") or ""
    url = pin.get("canonical_url")

    text_info = _analyze_text(title, note)
    country = _country_at(float(pin["lat"]), float(pin["lng"]))
    url_info = _check_url(url) if url else None
    llm = _llm_verdict(pin, text_info, url_info, country)

    mod_deep: dict = {
        "text": text_info,
        "country_at_point": country,
        "ocean_point": country is None,
        "url": url_info,
        "llm": llm,
        "at": _utcnow(),
    }

    if llm is None:
        status = "deep_ok_no_llm"
    elif llm["ok"]:
        status = "deep_ok"
    else:
        status = "rejected"

    # Category refinement: only when the user didn't pick one themselves
    # and the LLM suggested a valid, different category.
    new_category = None
    if llm and llm.get("category") and not user_category \
            and llm["category"] != pin.get("category"):
        new_category = llm["category"]
        mod_deep["category_refined"] = {"from": pin.get("category"), "to": new_category}

    _persist(pin_id, mod_deep, status, hide=(status == "rejected"),
             new_category=new_category)
    log.info("moderate_pin %s → %s (llm=%s, ocean=%s)",
             pin_id, status, "run" if llm else "skipped", country is None)
    return {"pin_id": pin_id, "mod_status": status, "mod_deep": mod_deep}
