"""AI extractor — pulls pending news_articles rows, asks the local Gemma-4
endpoint for structured JSON, and writes the extracted fields back.

The model returns place name (NOT coordinates) plus summary / event_type /
entities / topic_tags. A separate geocode step turns place names into lat/lng.

Falls back to regex extraction of location phrase from title when the model
returns malformed output or times out.

"Why not just use regex for everything?"
Because regex can't understand context. "Apple announces new iPhone" —
is that about Cupertino or a fruit? The AI knows. Regex doesn't.

"Why does it return place names instead of coordinates?"
Because geocoding is a separate step that has its own retry logic,
caching, and rate limiting. Mixing them would make both harder to
debug. Separation of concerns: the AI reads, the geocoder locates.
"""
import asyncio
import json
import logging
import os
import re
import time
from typing import Any

import httpx

from .ai_client import ai_chat_stream
from .db import connect
from .progress import ProgressWriter

log = logging.getLogger("newsium.extract")


def _strip_cdata(text: str | None) -> str:
    """Clean RSS CDATA wrappers (<![CDATA[ ... ]]) and surrounding whitespace from text."""
    if not text:
        return ""
    stripped = re.sub(r"<!\[CDATA\[\s*(.*?)\s*\]\]>", r"\1", text, flags=re.DOTALL | re.IGNORECASE)
    return stripped.strip()

CHAT_URL = os.environ.get(
    "NEWSIUM_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
SAFE_HEADERS = {"X-MCP-Safe": "true"}
TIMEOUT_S = float(os.environ.get("NEWSIUM_AI_TIMEOUT", "25"))
MAX_ARTICLES_PER_CYCLE = int(os.environ.get("NEWSIUM_AI_MAX_PER_CYCLE", "60"))

EXTRACTION_SYSTEM_PROMPT = """You are a news analysis engine. Given an article's title and body, respond with ONLY a JSON object — no prose, no markdown fences, no comments.

Required shape:
{
  "summary": "one or two sentence neutral summary",
  "location_text": "the single most specific place name tied to the core event, or null",
  "event_type": "one of: politics, business, crime, weather, science, technology, sports, culture, environment, conflict, health, disaster, humanitarian, maritime, cyclone, sea_level, coral_reef, other",
  "entities": ["list", "of", "key", "named", "entities", "—", "people", "and", "organizations"],
  "topic_tags": []
}

Hard rules:
- "topic_tags" must list 3 to 6 SHORT topical tags for THIS article — for example "election", "climate", "semiconductors", "Gaza". Use the words that describe the story. Never write the words "topic", "tags", "short" or "3-6" as a tag, and never copy any example from this prompt.
- Do NOT include lat/lng coordinates. A separate geocoder handles that.
- If multiple locations are mentioned, pick the one most central to the main event — not incidental datelines or quoted officials' hometowns.
- "location_text" should be a place name that can be resolved by a geocoder: "Beirut, Lebanon" not "the building" or "northern outskirts".
- If the article has no clear geographic anchor, set "location_text" to null.
- "summary" must be one or two sentences. No more.
- Keep "entities" under 8 items. Names only, no descriptions.
- If the article is from a domestic news source about domestic affairs, prefer locations in that country. If it's about a foreign country, use that country. Do NOT place domestic news in a random foreign city.

PACIFIC ISLAND SPECIAL CONTEXT:
- For Pacific island nations (FJ=Fiji, SB=Solomon Islands, VU=Vanuatu, WS=Samoa, TO=Tonga, PG=Papua New Guinea, KI=Kiribati, TV=Tuvalu, NR=Nauru, FM=Micronesia, MH=Marshall Islands, PW=Palau, CK=Cook Islands), be aware that:
  - Events often affect small island populations directly — a single cyclone can be national news
  - "Pacific" or "regional Pacific" is a valid location for multi-country stories
  - Climate change stories (sea level rise, coral bleaching) are common — use "sea_level" or "coral_reef" event_type
  - Fishing, maritime, and Exclusive Economic Zone (EEZ) disputes are frequent topics
  - Tropical cyclones are common — use "cyclone" event_type for storms
- City names: Suva/Lautoka (Fiji), Honiara (Solomon Islands), Port Vila (Vanuatu), Apia (Samoa), Nukualofa (Tonga), Port Moresby (PNG), Majuro (Marshall Islands), Palikir (Micronesia)
"""


def _stream_chat(client: httpx.Client, user_prompt: str) -> str:
    """Stream a chat completion; return the concatenated assistant text.

    The local endpoint at 192.168.1.3:8888/chat/stream takes a single
    `message` string (not OpenAI's `messages` array). The system prompt is
    prepended to the user message so the model still sees the instructions.
    """
    payload = {
        "message": EXTRACTION_SYSTEM_PROMPT + "\n\n" + user_prompt,
        "stream": True,
    }
    full = ""
    with client.stream("POST", CHAT_URL, json=payload, headers=SAFE_HEADERS, timeout=TIMEOUT_S) as resp:
        resp.raise_for_status()
        buf = ""
        for chunk in resp.iter_text():
            if not chunk:
                continue
            buf += chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload_str = line[5:].strip()
                if payload_str == "[DONE]":
                    return full
                try:
                    obj = json.loads(payload_str)
                except json.JSONDecodeError:
                    continue
                delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                if delta:
                    full += delta
    return full


def _first_json_block(text: str) -> dict | None:
    """Find the first {...} JSON object in the model output and parse it."""
    candidates = re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", text)
    for cand in candidates:
        try:
            obj = json.loads(cand)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


# Circuit breaker constants & state
_BREAKER_FAIL_THRESHOLD = 5
_BREAKER_FAIL_WINDOW_S = 300
_BREAKER_COOLDOWN_S = 180

_breaker_state: dict[str, Any] = {
    "failures": [],
    "open_until": 0.0,
}


def _ai_call_allowed() -> bool:
    """Check if the AI circuit breaker is closed or half-open."""
    now = time.time()
    if now < _breaker_state["open_until"]:
        return False
    # Prune old failures
    _breaker_state["failures"] = [
        t for t in _breaker_state["failures"]
        if t >= now - _BREAKER_FAIL_WINDOW_S
    ]
    return True


def _ai_record_failure(reason: str = "") -> None:
    """Record an AI failure and trip the breaker if threshold reached."""
    now = time.time()
    _breaker_state["failures"] = [
        t for t in _breaker_state["failures"]
        if t >= now - _BREAKER_FAIL_WINDOW_S
    ]
    _breaker_state["failures"].append(now)
    if len(_breaker_state["failures"]) >= _BREAKER_FAIL_THRESHOLD:
        _breaker_state["open_until"] = now + _BREAKER_COOLDOWN_S
        log.warning(
            "AI circuit breaker OPENED due to %d failures (cooldown %ds, last error: %s)",
            len(_breaker_state["failures"]), _BREAKER_COOLDOWN_S, reason,
        )


def _ai_record_success() -> None:
    """Reset failure counter and close breaker on success."""
    _breaker_state["failures"].clear()
    _breaker_state["open_until"] = 0.0


def breaker_snapshot() -> dict[str, Any]:
    """Return circuit breaker status dictionary."""
    now = time.time()
    is_open = now < _breaker_state["open_until"]
    return {
        "open": is_open,
        "open_for_seconds": max(0.0, _breaker_state["open_until"] - now) if is_open else 0.0,
        "recent_failures": len([
            t for t in _breaker_state["failures"]
            if t >= now - _BREAKER_FAIL_WINDOW_S
        ]),
        "fail_threshold": _BREAKER_FAIL_THRESHOLD,
    }


# ── Async parallel extraction ─────────────────────────────────────────────────
# Uses asyncio + Semaphore to run N extractions concurrently, dramatically
# reducing wall-clock time for large batches (60 articles × 3s = 180s sequential
# → ~30s with 8 concurrent workers, still within the 60/min rate limit).


async def _stream_ai_response(messages: list[dict]) -> str:
    """Call ai_chat_stream and collect the full assistant response."""
    full = ""
    async for line in ai_chat_stream(messages):
        if line == "[DONE]":
            break
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
        if delta:
            full += delta
    return full


async def _extract_one_async(
    art: dict, sem: asyncio.Semaphore
) -> tuple[int, dict, str]:
    """Async extraction for a single article. Returns (id, extraction_dict, status).

    Cache check and cache write are synchronous (fast). Only the AI call is async.
    Controlled concurrency via semaphore ensures we stay within rate limits.
    """
    import hashlib

    article_id = art["id"]
    source_country = art.get("source_country") or "unknown"
    source_name = art.get("source_name") or "unknown"

    # FIX_NOTES 6.2: cache key now includes the source — the prompt embeds
    # source name/country and uses body[:2500], so two syndicated copies of
    # one story from different countries must NOT share an extraction
    # (the old key cross-contaminated the source-country prior).
    content_hash = hashlib.sha256(
        f"{art.get('source_id', '?')}|{source_country}|{art.get('title', '')}|{art.get('body', '')[:2500]}".encode()
    ).hexdigest()

    # FIX_NOTES 6.1: cache check moved BEFORE the circuit-breaker check —
    # the cache is free; with the old order an open breaker threw away
    # cached results AND silently dropped source_country from the regex
    # fallback below (weakening the cross-country guard).
    # Check cache first (sync but fast)
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT result FROM ai_cache WHERE content_hash = %s",
                (content_hash,)
            )
            cached = cur.fetchone()
            if cached:
                cur.execute(
                    "UPDATE ai_cache SET last_used_at = now(), use_count = use_count + 1 WHERE content_hash = %s",
                    (content_hash,)
                )
                conn.commit()
                return article_id, cached["result"], "extracted"
    except Exception as e:
        log.debug("AI cache check failed: %s", e)

    if not _ai_call_allowed():
        log.info("circuit breaker open, using regex fallback for article %s", article_id)
        obj = _regex_fallback(art["title"], art.get("body", ""), source_country)
        # Only park as 'unlocated' if the fallback really found nothing;
        # previously this returned 'unlocated' even when a location was found.
        status = "extracted" if obj.get("location_text") else "unlocated"
        return article_id, obj, status

    prompt = (
        f"Source: {source_name} (based in {source_country})\n\n"
        f"Title: {art['title']}\n\n"
        f"Body:\n{art.get('body', '')[:2500]}"
    )
    messages = [
        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    obj: dict[str, Any] = {}
    async with sem:
        try:
            text = await _stream_ai_response(messages)
            obj = _first_json_block(text)
            if obj is None:
                log.warning("malformed AI output for article %s, falling back", article_id)
                _ai_record_failure("malformed JSON output")
                obj = _regex_fallback(art["title"], art.get("body", ""))
            else:
                _ai_record_success()
                obj = _normalize(obj)
        except Exception as exc:
            log.warning("AI call failed for article %s: %s", article_id, exc)
            _ai_record_failure(str(exc))
            obj = _regex_fallback(art["title"], art.get("body", ""))

    # Cross-country validation (sync, same as before)
    if obj.get("location_text") and source_country and source_country != "unknown":
        try:
            from . import cities_text
            from .auto_categorize import _detect_country_mentions
            stats = cities_text.stats(obj["location_text"])
            primary = stats.get("primary") if stats else None
            if primary:
                loc_country = (primary.get("country_code") or "").upper()
                src_country = source_country.upper()
                if loc_country and src_country and loc_country != src_country:
                    title = art.get("title") or ""
                    body = art.get("body") or ""
                    mentioned = _detect_country_mentions(title) | _detect_country_mentions(body[:500])
                    # Reject if city country is NOT mentioned in text
                    # (stronger than old check which also required src_country in mentioned)
                    if loc_country not in mentioned:
                        log.info(
                            "AI cross-country: article %s from %s (%s) placed in %s but text doesn't mention %s — clearing location",
                            article_id, source_name, src_country,
                            obj["location_text"], loc_country,
                        )
                        obj["location_text"] = None
        except Exception:
            pass

    # Place disambiguation (same as before)
    if obj.get("location_text"):
        try:
            from .place_disambiguation import disambiguate
            from .disambiguation_gemma import disambiguate_with_gemma, needs_gemma_disambiguation

            title_text = art.get("title") or ""
            body_text = art.get("body", "")
            ctx = f"{title_text}\n{body_text[:2500]}"
            keep, reason = disambiguate(obj["location_text"], ctx, source_country=source_country)
            if not keep:
                log.info("AI disambig: article %s location_text=%r dropped (%s)", article_id, obj["location_text"], reason)
                obj["location_text"] = None
            else:
                # Gemma disambiguation for known ambiguous cases
                # This uses 27-BILLION PARAMETER Gemma model for ultimate accuracy
                if source_country and source_country != "unknown" and needs_gemma_disambiguation(obj["location_text"], source_country):
                    try:
                        import asyncio
                        gemma_result = await disambiguate_with_gemma(
                            art.get("title", ""),
                            obj.get("summary", ""),
                            art.get("body"),
                            obj["location_text"],
                            source_country,
                        )
                        if gemma_result.get("location_text") and gemma_result.get("confidence", 0) >= 0.85:
                            old_loc = obj["location_text"]
                            obj["location_text"] = gemma_result["location_text"]
                            log.info(
                                "Gemma disambig: article %s location %r → %r (confidence=%.2f)",
                                article_id, old_loc, obj["location_text"], gemma_result["confidence"]
                            )
                    except Exception as e:
                        log.debug("Gemma disambiguation failed for article %s: %s", article_id, e)
        except Exception:
            pass

    # Suburb-priority refinement: AI often returns the dateline metro
    # ("Chicago") when the story is actually about a named suburb
    # ("Naperville"). Move placement to the suburb when the text makes
    # it the real subject.
    if obj.get("location_text"):
        try:
            from . import cities_text as _ct
            from .suburb_priority import refine as _refine_suburb, suburb_label
            _stats = _ct.stats(obj["location_text"])
            _parent = _stats.get("primary")
            if _parent:
                _suburb, _why = _refine_suburb(
                    _parent, art.get("title") or "", art.get("body") or "")
                if _suburb:
                    old = obj["location_text"]
                    obj["location_text"] = suburb_label(_suburb)
                    log.info(
                        "suburb-priority: article %s location %r → %r (%s)",
                        article_id, old, obj["location_text"], _why)
        except Exception as e:
            log.debug("suburb-priority refine failed for %s: %s", article_id, e)

    # Cache result (sync)
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ai_cache (content_hash, result)
                VALUES (%s, %s)
                ON CONFLICT (content_hash) DO UPDATE
                SET last_used_at = now(), use_count = ai_cache.use_count + 1
                """,
                (content_hash, json.dumps(obj))
            )
            conn.commit()
    except Exception as e:
        log.debug("AI cache store failed: %s", e)

    status = "extracted" if obj.get("location_text") else "unlocated"
    return article_id, obj, status


async def _run_async(pending: list[dict], progress: ProgressWriter | None, concurrency: int = 8) -> tuple[list, dict]:
    """Run extractions asynchronously with controlled concurrency.

    concurrency: max simultaneous AI calls (keep <= rate_limit_per_minute / 2)
    """
    sem = asyncio.Semaphore(concurrency)
    coords_map = _batch_check_coords([a["id"] for a in pending])

    async def extract_with_coords(art: dict):
        article_id, obj, status = await _extract_one_async(art, sem)
        extracted_lat = coords_map.get(art["id"])
        if extracted_lat is not None:
            status = "extracted"
        return (article_id, obj, status)

    results: list[tuple[int, dict, str]] = []
    total = len(pending)

    for i in range(0, total, concurrency):
        batch = pending[i:i + concurrency]
        batch_results = await asyncio.gather(
            *[extract_with_coords(art) for art in batch],
            return_exceptions=True
        )
        for res in batch_results:
            if isinstance(res, Exception):
                log.error("async extraction failed: %s", res)
                continue
            results.append(res)

        done = min(i + concurrency, total)
        if progress:
            progress.update(
                step="extract",
                detail=f"Extracted {done}/{total} articles",
            )

    return results, {"extracted": sum(1 for r in results if r[2] == "extracted"), "failed": sum(1 for r in results if r[2] == "unlocated")}


# Heuristics for fallback when the model returns malformed output.
CAPITALIZED_PHRASE = re.compile(
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}(?:,\s+[A-Z][a-zA-Z]+)?)\b"
)
EVENT_TYPES = {
    "politics", "business", "crime", "weather", "science", "technology",
    "sports", "culture", "environment", "conflict", "health", "disaster",
    "humanitarian", "other",
    # FIX_NOTES 6.3: EXTRACTION_SYSTEM_PROMPT offers these four to the
    # model but the validator used to rewrite them to "other", throwing
    # away correct answers (cyclone=132, maritime=2727, sea_level, coral_reef
    # all exist in the DB). Enums must match the prompt.
    "maritime", "cyclone", "sea_level", "coral_reef",
}

IGNORE_LOCATION_WORDS = {
    "the", "a", "an", "in", "on", "at", "by", "for", "with", "from", "to", "of",
    "strong", "major", "breaking", "new", "huge", "deadly", "massive", "global",
    "local", "latest", "top", "update", "alert", "report", "one", "two", "three",
}


def _regex_fallback(title: str, body: str, source_country: str | None = None) -> dict:
    """Last-ditch extraction when the model output isn't valid JSON."""
    from . import cities_text
    from .classify import classify

    text = f"{title}\n{body[:500]}"
    
    # Try cities_text first for high-accuracy city extraction
    location = None
    try:
        stats = cities_text.stats(text)
        if stats and stats.get("primary"):
            primary = stats["primary"]
            # Cross-country check: if the detected city is in a different
            # country than the source, and the text mentions the source
            # country, skip this city.
            if source_country and primary.get("country_code"):
                from .auto_categorize import _detect_country_mentions
                city_cc = primary["country_code"].upper()
                src_cc = source_country.upper()
                if city_cc != src_cc:
                    mentioned = _detect_country_mentions(title) | _detect_country_mentions(body[:500])
                    if city_cc not in mentioned:
                        # City country not mentioned in text → skip
                        location = None
                    else:
                        location = f"{primary['name']}, {primary['country_code']}" if primary.get("country_code") else primary['name']
                else:
                    location = f"{primary['name']}, {primary['country_code']}" if primary.get("country_code") else primary['name']
            else:
                location = f"{primary['name']}, {primary['country_code']}" if primary.get("country_code") else primary['name']
    except Exception:
        pass

    if not location:
        # Fallback to capitalized phrase search, ignoring common headline words
        for m in CAPITALIZED_PHRASE.finditer(text):
            candidate = m.group(1).strip()
            if candidate.lower() in IGNORE_LOCATION_WORDS:
                continue
            if candidate in EVENT_TYPES or candidate.lower() in EVENT_TYPES:
                continue
            first_word = candidate.split()[0].lower()
            if first_word in IGNORE_LOCATION_WORDS:
                # Strip leading adjective/article (e.g. "Strong earthquake hits Tokyo" -> "Tokyo")
                parts = candidate.split()
                if len(parts) > 1:
                    candidate = " ".join(parts[1:])
                else:
                    continue
            location = candidate
            break

    event = classify(title, body)

    return {
        "summary": title.strip()[:300],
        "location_text": location,
        "event_type": event,
        "entities": [],
        "topic_tags": [],
    }


def _as_str_list(val) -> list[str]:
    """Coerce model output to a list of non-empty strings.
    - str -> [str] (single item, NOT characters)
    - list -> [str(x) for x in list if x truthy]
    - anything else -> []
    """
    if isinstance(val, str):
        val = [val]
    if not isinstance(val, (list, tuple)):
        return []
    return [str(x).strip() for x in val if x and str(x).strip()]


# ── Topic tags: structural ARTEFACTS, not topics ─────────────────────────
#
# The system prompt used to show the model this shape:
#
#     "topic_tags": ["3-6", "short", "topic", "tags"]
#
# and a great many models copied it VERBATIM: those four words are literal
# tags on thousands of articles ("3-6" 2,741 · "short" 1,482 · "tags"
# 1,395 · "topic" 1,265). A chip labelled "topic" is not a topic — a
# reader who clicked it got a map of articles about nothing in particular,
# which is exactly what it looks like.
#
# The prompt no longer shows a copyable example (it asks for the tags in
# prose and shows an empty list), but a model that answers with a
# placeholder anyway must not be able to WRITE one. So the words are
# stripped here, and an article left with no tags falls back to its event
# type — which is a real topic.
STRUCTURAL_TAGS = frozenset({"3-6", "short", "tags", "topic"})


def _clean_topic_tags(raw: object, event_type: object | None = None) -> list[str]:
    """The model's topic tags, minus the structural artefacts."""
    tags = [
        t for t in _as_str_list(raw)[:6]
        if t.strip().lower() not in STRUCTURAL_TAGS
    ]
    if not tags:
        et = str(event_type or "").strip().lower()
        if et and et != "other":
            tags = [et]
    return tags


def _normalize(extracted: dict) -> dict:
    out = {
        "summary": str(extracted.get("summary") or "").strip()[:1000],
        "location_text": (str(extracted.get("location_text")).strip()
                          if extracted.get("location_text") else None),
        "event_type": str(extracted.get("event_type") or "other").strip().lower(),
        # FIX_NOTES 6.4: a model returning entities as a plain string used
        # to become list("Apple") == ['A','p','p','l','e'] written to the DB.
        "entities": _as_str_list(extracted.get("entities"))[:8],
        "topic_tags": _clean_topic_tags(
            extracted.get("topic_tags"), extracted.get("event_type")
        ),
    }
    if out["event_type"] not in EVENT_TYPES:
        out["event_type"] = "other"
    return out


def extract_one(client: httpx.Client, article: dict) -> dict:
    """Call AI; return a normalized extraction dict. Never raises."""
    import hashlib
    source_country = article.get("source_country") or "unknown"
    source_name = article.get("source_name") or "unknown"

    # Check cache first to avoid re-extracting duplicate content
    # FIX_NOTES 6.2: source-aware key (see async path comment)
    content_hash = hashlib.sha256(
        f"{article.get('source_id', '?')}|{source_country}|{article.get('title', '')}|{article.get('body', '')[:2500]}".encode()
    ).hexdigest()
    
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT result FROM ai_cache WHERE content_hash = %s",
                (content_hash,)
            )
            cached = cur.fetchone()
            if cached:
                log.debug("AI cache hit for article %s (hash=%s)", article.get("id"), content_hash[:12])
                # Update usage stats
                cur.execute(
                    "UPDATE ai_cache SET last_used_at = now(), use_count = use_count + 1 WHERE content_hash = %s",
                    (content_hash,)
                )
                conn.commit()
                return cached["result"]
    except Exception as e:
        log.debug("AI cache check failed: %s", e)

    if not _ai_call_allowed():
        log.info("circuit breaker open, using regex fallback for article %s", article.get("id"))
        return _regex_fallback(article["title"], article.get("body", ""), source_country)

    # Include source context in the prompt so the AI can make better
    # location decisions (e.g. Korean source about China shouldn't be
    # placed in Germany).
    prompt = (
        f"Source: {source_name} (based in {source_country})\n\n"
        f"Title: {article['title']}\n\n"
        f"Body:\n{article.get('body', '')[:2500]}"
    )
    try:
        text = _stream_chat(client, prompt)
        obj = _first_json_block(text)
        if obj is None:
            log.warning("malformed AI output for article %s, falling back. raw=%r", article["id"], text[:120])
            _ai_record_failure("malformed JSON output")
            obj = _regex_fallback(article["title"], article.get("body", ""))
        else:
            _ai_record_success()
            obj = _normalize(obj)
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        log.warning("AI call failed for article %s: %s", article["id"], exc)
        _ai_record_failure(str(exc))
        obj = _regex_fallback(article["title"], article.get("body", ""))

    # Post-extraction cross-country validation: if the AI placed the
    # article in a different country than the source, and the text
    # doesn't mention that country, the placement is suspicious.
    if obj.get("location_text") and source_country and source_country != "unknown":
        from . import cities_text
        from .auto_categorize import _detect_country_mentions
        try:
            stats = cities_text.stats(obj["location_text"])
            primary = stats.get("primary") if stats else None
            if primary:
                loc_country = (primary.get("country_code") or "").upper()
                src_country = source_country.upper()
                if loc_country and src_country and loc_country != src_country:
                    # Check if the text actually mentions the location's country
                    title = article.get("title") or ""
                    body = article.get("body") or ""
                    mentioned = _detect_country_mentions(title) | _detect_country_mentions(body[:500])
                    if loc_country not in mentioned and src_country in mentioned:
                        # Text mentions source country but not the detected
                        # location's country → likely wrong placement
                        log.info(
                            "AI cross-country: article %s from %s (%s) placed in %s but text mentions %s — clearing location",
                            article["id"], source_name, src_country,
                            obj["location_text"], ",".join(mentioned),
                        )
                        obj["location_text"] = None
        except Exception:
            pass  # validation is best-effort

    # Place-disambiguation watchlist (small ambiguous towns only —
    # globally-famous cities are auto-allowed). If the AI emits a
    # bare location_text that exists in many countries (Man, Springfield,
    # Cordoba, etc.) but the article title/body never mentions a
    # context keyword for that place, drop the location rather than
    # pin to a wrong country.
    if obj.get("location_text"):
        try:
            from .place_disambiguation import disambiguate
            title_text = article.get("title") or ""
            body_text = article.get("body") or ""
            ctx = f"{title_text}\n{body_text[:2500]}"
            keep, reason = disambiguate(obj["location_text"], ctx, source_country=source_country)
            if not keep:
                log.info(
                    "AI disambig: article %s location_text=%r dropped (%s)",
                    article["id"], obj["location_text"], reason,
                )
                obj["location_text"] = None
        except Exception:
            pass  # disambiguation is best-effort; never block extraction

    # Cache the result for future use
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ai_cache (content_hash, result)
                VALUES (%s, %s)
                ON CONFLICT (content_hash) DO UPDATE
                SET last_used_at = now(), use_count = ai_cache.use_count + 1
                """,
                (content_hash, json.dumps(obj))
            )
            conn.commit()
            log.debug("Cached AI extraction for article %s (hash=%s)", article.get("id"), content_hash[:12])
    except Exception as e:
        log.debug("AI cache store failed: %s", e)

    return obj


def _lightweight_extract(article: dict) -> dict:
    """Fast keyword/regex fallback extraction for an article."""
    title = article.get("title", "")
    body = article.get("body", "")
    return _regex_fallback(title, body, article.get("source_country"))


def _batch_check_coords(article_ids: list[int]) -> dict[int, Any]:
    if not article_ids:
        return {}
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, extracted_lat FROM news_articles WHERE id = ANY(%s)", (article_ids,))
        rows = cur.fetchall()
        return {
            (r["id"] if isinstance(r, dict) else r[0]): (r["extracted_lat"] if isinstance(r, dict) else r[1])
            for r in rows
        }


def _batch_update_articles(updates: list[tuple[int, dict, str]]) -> None:
    if not updates:
        return
    query = """
        UPDATE news_articles
        SET summary = %s,
            location_text = %s,
            event_type = %s,
            entities = %s::text[],
            topic_tags = %s::text[],
            status = %s,
            error_message = %s,
            extracted_at = now()
        WHERE id = %s
    """
    with connect() as conn, conn.cursor() as cur:
        # FIX (2026-11-01) — the same defect learn.py fixed on 2026-09-26
        # for update_source_keywords(), still present here.
        #
        # This loop used to run the WHOLE batch inside ONE transaction
        # (there was no commit at all; the pool committed on exit). Two
        # consequences, both observed:
        #
        #   1. ONE failed statement rolled back every row in the batch —
        #      hours of Gemma extraction discarded because a single
        #      UPDATE hit the timeout.
        #   2. The transaction stayed open for the entire batch, holding
        #      row locks on news_articles the whole time. That is the
        #      shape that starves OTHER writers into tripping
        #      statement_timeout themselves (the nightly died this way at
        #      extract.py:721 on 10-29), and it blocks autovacuum.
        #
        # Per-row commit bounds both: a failure loses at most one row and
        # no lock is held longer than one UPDATE.
        #
        # The timeout is raised for these statements only. Each UPDATE is
        # bounded work — the trg_detect_cities trigger scans 8,264
        # world_cities rows (no index serves its `LIKE '%…%'`) over
        # title + the first 500 chars of body, measured at ~1.1 s — so a
        # 60 s ceiling was never about the query being slow, it was about
        # WAITING: a lock held elsewhere, or the box swapping. 300 s
        # absorbs that contention while still failing loudly if a row
        # never completes.
        #
        # SET LOCAL rather than SET + RESET: it is transaction-scoped, so
        # it dies with this row's commit (or rollback) and can never leak
        # the raised value to the next checkout. That also removes a
        # real trap — after a failed row the transaction is ABORTED, and
        # a `RESET` issued from a `finally` would itself raise
        # InFailedSqlTransaction, masking the original error and leaving
        # the pooled connection dirty for everyone after us.
        for art_id, ext, status in updates:
            started = time.time()
            cur.execute("SET LOCAL statement_timeout = '300s'")
            cur.execute(
                query,
                (
                    ext.get("summary"),
                    ext.get("location_text"),
                    ext.get("event_type"),
                    ext.get("entities", []),
                    ext.get("topic_tags", []),
                    status,
                    ext.get("error_message"),
                    art_id,
                ),
            )
            conn.commit()
            took = time.time() - started
            # Surface the slow rows instead of letting them hide inside a
            # batch that either crawls or dies.
            if took > 30:
                log.warning(
                    "extract: article %s update took %.1fs "
                    "(city-detection trigger); batch=%d",
                    art_id, took, len(updates),
                )


def _update_article(article_id: int, extraction: dict, status: str, error: str | None = None) -> None:
    _batch_update_articles([(article_id, {**extraction, "error_message": error}, status)])


def _requeue_stale_processing(max_age_minutes: int = 120) -> int:
    """A crashed extract run must not strand rows in 'processing' forever."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_articles SET status = 'pending', processing_at = NULL "
            "WHERE status = 'processing' AND processing_at < now() - (%s || ' minutes')::interval "
            "RETURNING id",
            (str(max_age_minutes),),
        )
        n = len(cur.fetchall())
        conn.commit()
    return n


def _fetch_pending(limit: int) -> list[dict]:
    """Atomically claim up to `limit` pending articles for extraction.

    FIX_NOTES 6.5: this used to be a plain SELECT — the 15-min fetcher and
    the nightly run both grabbed the same 2,000 rows and paid twice for
    the same Gemma GPU work. Rows are claimed via UPDATE...RETURNING into
    the 'processing' status (migration
    api/migrations/2026-09-26-extract-processing.sql); the batch writer
    then moves each row to its terminal status, so a claim can never be
    re-claimed while in flight.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            WITH claim AS (
                SELECT id FROM news_articles
                WHERE status = 'pending'
                ORDER BY fetched_at DESC
                LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            UPDATE news_articles a
            SET status = 'processing', processing_at = now()
            FROM claim
            WHERE a.id = claim.id
            RETURNING a.id, a.title, a.body, a.source_id
            """
            ,
            (limit,),
        )
        rows = cur.fetchall()
        conn.commit()
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT a.id, a.title, a.body, a.source_id, s.country as source_country, s.name as source_name "
            "FROM news_articles a "
            "LEFT JOIN news_sources s ON s.id = a.source_id "
            "WHERE a.id = ANY(%s)",
            (ids,),
        )
        out = cur.fetchall()
    by_id = {r["id"]: r for r in out}
    return [by_id[i] for i in ids if i in by_id]


def run(limit: int = MAX_ARTICLES_PER_CYCLE, progress: ProgressWriter | None = None) -> dict:
    try:
        requeued = _requeue_stale_processing()
        if requeued:
            log.info("extract: requeued %d stale 'processing' rows", requeued)
    except Exception as exc:  # noqa: BLE001
        log.warning("extract: stale-processing sweep failed: %s", exc)
    pending = _fetch_pending(limit)
    log.info("extract: %d pending (cap %d)", len(pending), limit)
    if progress:
        progress.update(step="extract", detail=f"Extracting {len(pending)} articles...")
    if not pending:
        _batch_update_articles([])
        return {"extracted": 0, "failed": 0}

    updates, summary = asyncio.run(_run_async(pending, progress, concurrency=8))
    _batch_update_articles(updates)
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(run())
