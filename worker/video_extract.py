"""AI extractor for video — pulls transcribed video_items, asks the local
Gemma-4 endpoint for structured JSON, and writes extracted fields back.

Pipeline position:
  video_fetch (pending) → video_transcript (transcribed) → video_extract (extracted) → geocode → cluster

Similar to worker/extract.py but adapted for video content:
  - Input: video_items with status='transcribed' (has transcript_text)
  - Also processes 'pending' videos without transcripts (using title+description)
  - Output: summary, location_text, event_type, entities, topic_tags, speakers
"""
import json
import logging
import os
import re
from typing import Any

import httpx

from .db import connect
from .progress import ProgressWriter

log = logging.getLogger("xyzo.video_extract")

CHAT_URL = os.environ.get(
    "NEWSIUM_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
SAFE_HEADERS = {"X-MCP-Safe": "true"}
TIMEOUT_S = float(os.environ.get("NEWSIUM_AI_TIMEOUT", "25"))
MAX_VIDEOS_PER_CYCLE = int(os.environ.get("XYZO_VIDEO_AI_MAX", "60"))

VIDEO_EXTRACTION_PROMPT = """You are a video news analysis engine. Given a video's title, description, and (if available) transcript, respond with ONLY a JSON object — no prose, no markdown fences, no comments.

Required shape:
{
  "summary": "one or two sentence neutral summary of what the video covers",
  "location_text": "the single most specific place name tied to the core event, or null",
  "event_type": "one of: politics, business, crime, weather, science, technology, sports, culture, environment, conflict, health, disaster, humanitarian, other",
  "entities": ["list", "of", "key", "named", "entities", "—", "people", "and", "organizations"],
  "topic_tags": ["3-6", "short", "topic", "tags"],
  "speakers": ["names", "of", "people", "speaking", "in", "the", "video"],
  "video_type": "one of: news_report, live_news, interview, press_conference, documentary, explainer, investigation, field_report, eyewitness, citizen_video, video_podcast, lecture, conference, government_video, science_video, weather, disaster, sports_news, culture, travel, food, tech, business, religion, community, other"
}

Hard rules:
- Do NOT include lat/lng coordinates. A separate geocoder handles that.
- If multiple locations are mentioned, pick the one most central to the main event.
- "location_text" should be a place name resolvable by a geocoder: "Nairobi, Kenya" not "the building".
- If no clear geographic anchor, set "location_text" to null.
- "summary" must be one or two sentences. No more.
- Keep "entities" under 8 items. Names only, no descriptions.
- "speakers" should list people who speak on camera or are interviewed. Channel name alone is not a speaker.
- For transcripts, extract speakers from context clues (introductions, "I'm joined by", lower thirds).
- If no transcript is available, base analysis on title, description, and channel context.
"""


def _strip_cdata(text: str | None) -> str:
    if not text:
        return ""
    stripped = re.sub(r"<!\[CDATA\[\s*(.*?)\s*\]\]>", r"\1", text, flags=re.DOTALL | re.IGNORECASE)
    return stripped.strip()


def _build_video_prompt(video: dict, source_country: str | None = None) -> str:
    """Build the user prompt for video extraction."""
    parts = []

    title = video.get("title", "")
    description = video.get("description", "")[:2000]
    transcript = video.get("transcript_text", "")
    channel_name = video.get("channel_name", "")

    parts.append(f"Title: {title}")

    if channel_name:
        parts.append(f"Channel: {channel_name}")

    if description:
        parts.append(f"Description: {description[:1500]}")

    if transcript:
        # Truncate very long transcripts — 8000 chars is plenty for context
        truncated = transcript[:8000]
        parts.append(f"Transcript:\n{truncated}")

    if source_country:
        parts.append(f"\nSource country: {source_country}")

    return "\n\n".join(parts)


def _parse_ai_response(raw: str) -> dict | None:
    """Parse the AI's JSON response, handling common formatting issues."""
    if not raw:
        return None

    # Strip markdown fences
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```\s*$", "", cleaned)

    # Try direct parse
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Try to find JSON object in the response
    m = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass

    return None


# ── Circuit breaker (same pattern as extract.py) ──────────────────────────

class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, cooldown_s: float = 180):
        self.failure_threshold = failure_threshold
        self.cooldown_s = cooldown_s
        self.failures = 0
        self.opened_at = 0.0

    @property
    def is_open(self) -> bool:
        if self.failures < self.failure_threshold:
            return False
        import time
        return (time.time() - self.opened_at) < self.cooldown_s

    def record_failure(self):
        import time
        self.failures += 1
        if self.failures >= self.failure_threshold:
            self.opened_at = time.time()

    def record_success(self):
        self.failures = 0


_breaker = CircuitBreaker()


def _stream_chat(user_prompt: str) -> str:
    """Stream a chat completion; return the concatenated assistant text.

    Mirrors worker/extract.py _stream_chat for consistency.
    """
    payload = {
        "message": VIDEO_EXTRACTION_PROMPT + "\n\n" + user_prompt,
        "stream": True,
    }
    full = ""
    with httpx.Client(timeout=TIMEOUT_S) as client:
        with client.stream("POST", CHAT_URL, json=payload, headers=SAFE_HEADERS) as resp:
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


# ── Batch processing ─────────────────────────────────────────────────────

def _claim_videos_due(cur, batch_size: int) -> list[dict]:
    """Claim videos ready for AI extraction.

    Prioritizes transcribed videos, but also processes pending videos
    that have no transcript (using title + description only).
    """
    cur.execute("""
        WITH claimable AS (
            SELECT v.id, v.url, v.title, v.description, v.transcript_text,
                   v.status, v.channel_id,
                   c.name AS channel_name, c.country AS channel_country
            FROM video_items v
            JOIN video_channels c ON c.id = v.channel_id
            WHERE v.status IN ('transcribed', 'pending')
              AND v.extracted_at IS NULL
            ORDER BY
                CASE WHEN v.status = 'transcribed' AND v.transcript_text IS NOT NULL
                     THEN 0 ELSE 1 END,
                v.published_at DESC NULLS LAST,
                v.id
            LIMIT %s
            FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
            UPDATE video_items
            SET status = CASE WHEN video_items.status = 'pending' THEN 'extracted' ELSE video_items.status END
            FROM claimable
            WHERE video_items.id = claimable.id
            RETURNING video_items.id, video_items.url, video_items.title,
                      video_items.description, video_items.transcript_text,
                      video_items.status, video_items.channel_id,
                      claimable.channel_name, claimable.channel_country
        )
        SELECT id, url, title, description, transcript_text, status,
               channel_id, channel_name, channel_country
        FROM claimed ORDER BY id
    """, (batch_size,))
    return cur.fetchall()


def _update_extraction_result(cur, video_db_id: int, result: dict | None,
                               error: str | None = None) -> None:
    """Update a video item with extracted fields."""
    if error:
        cur.execute(
            "UPDATE video_items SET status = 'failed', error_message = %s WHERE id = %s",
            (error, video_db_id),
        )
        return

    if not result:
        cur.execute(
            "UPDATE video_items SET status = 'failed', error_message = 'empty_ai_response' WHERE id = %s",
            (video_db_id,),
        )
        return

    summary = result.get("summary", "")
    location_text = result.get("location_text")
    event_type = result.get("event_type", "other")
    entities = result.get("entities", [])
    topic_tags = result.get("topic_tags", [])
    speakers = result.get("speakers", [])
    video_type = result.get("video_type", "news_report")

    cur.execute(
        """UPDATE video_items SET
            summary = %s,
            location_text = %s,
            event_type = %s,
            entities = %s,
            topic_tags = %s,
            speakers = %s,
            video_type = %s,
            extracted_at = now(),
            status = 'extracted',
            error_message = NULL
        WHERE id = %s""",
        (
            summary[:2000],
            location_text,
            event_type,
            entities[:10],
            topic_tags[:8],
            speakers[:10],
            video_type,
            video_db_id,
        ),
    )


def _process_video(video: dict) -> dict | None:
    """Process a single video through AI extraction."""
    if _breaker.is_open:
        log.debug("video_extract: circuit breaker open, skipping")
        return None

    source_country = video.get("channel_country")
    prompt = _build_video_prompt(video, source_country)

    if not prompt or len(prompt) < 20:
        return None

    try:
        raw = _stream_chat(prompt)
    except Exception as exc:
        log.warning("video_extract: AI call failed: %s", exc)
        _breaker.record_failure()
        return None

    if not raw:
        _breaker.record_failure()
        return None

    result = _parse_ai_response(raw)
    if not result:
        log.warning("video_extract: failed to parse AI response for %s", video.get("url"))
        _breaker.record_failure()
        return None

    _breaker.record_success()
    return result


def run(limit: int = MAX_VIDEOS_PER_CYCLE, progress: ProgressWriter | None = None) -> dict:
    """Main entry point: AI extraction for video items.

    Processes videos sequentially through the AI endpoint.
    """
    summary = {
        "claimed": 0,
        "extracted": 0,
        "failed": 0,
        "errors": 0,
    }

    with connect() as conn, conn.cursor() as cur:
        videos = _claim_videos_due(cur, limit)

    summary["claimed"] = len(videos)
    if not videos:
        return summary

    log.info("video_extract: %d videos for AI extraction", len(videos))

    for video in videos:
        video_db_id = video["id"]
        try:
            result = _process_video(video)

            with connect() as conn, conn.cursor() as cur:
                if result:
                    _update_extraction_result(cur, video_db_id, result)
                    summary["extracted"] += 1
                else:
                    _update_extraction_result(cur, video_db_id, None,
                                               error="no_ai_result")
                    summary["failed"] += 1
                conn.commit()

        except Exception as exc:
            log.warning("video_extract: video %d failed: %s", video_db_id, exc)
            with connect() as conn, conn.cursor() as cur:
                _update_extraction_result(cur, video_db_id, None,
                                           error=str(exc)[:500])
                conn.commit()
            summary["errors"] += 1

    return summary


# ── CLI entry point ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run()
    json.dump(result, sys.stdout, default=str)
    sys.stdout.write("\n")
