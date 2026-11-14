"""Audio episode extractor — pulls pending audio_episodes rows, asks the
local Gemma-4 endpoint for structured JSON, and writes the extracted fields back.

Similar to extract.py but tailored for podcast episodes:
- Longer context (episode descriptions + show metadata)
- Person extraction (hosts, guests) with role classification
- Audio-specific event types (interview, panel, documentary, etc.)
- Geographic extraction from episode descriptions
"""
import json
import logging
import os
import re
import time

import httpx

from .ai_client import ai_chat_stream
from .db import connect
from .progress import ProgressWriter

log = logging.getLogger("xyzo.audio_extract")

CHAT_URL = os.environ.get(
    "NEWSIUM_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
SAFE_HEADERS = {"X-MCP-Safe": "true"}
TIMEOUT_S = float(os.environ.get("NEWSIUM_AI_TIMEOUT", "25"))
MAX_EPISODES_PER_CYCLE = int(os.environ.get("XYZO_AUDIO_EXTRACT_MAX", "60"))

AUDIO_EXTRACTION_SYSTEM_PROMPT = """You are an audio content analysis engine. Given a podcast episode's title, description, and show metadata, respond with ONLY a JSON object — no prose, no markdown fences, no comments.

Required shape:
{
  "summary": "one or two sentence neutral summary of the episode",
  "location_text": "the single most specific place name tied to the core topic, or null",
  "event_type": "one of: politics, business, crime, weather, science, technology, sports, culture, environment, conflict, health, disaster, humanitarian, interview, panel, documentary, analysis, investigation, other",
  "entities": ["list", "of", "key", "named", "entities", "—", "people", "and", "organizations"],
  "topic_tags": ["3-6", "short", "topic", "tags"],
  "hosts": ["known", "host", "names"],
  "guests": ["known", "guest", "names"]
}

Hard rules:
- Do NOT include lat/lng coordinates. A separate geocoder handles that.
- If multiple locations are mentioned, pick the one most central to the main topic.
- "location_text" should be a place name that can be resolved by a geocoder.
- If the episode has no clear geographic anchor, set "location_text" to null.
- "summary" must be one or two sentences. No more.
- Keep "entities" under 8 items. Names only, no descriptions.
- SOURCE CONTEXT: The show is based in {show_country}. If the episode is clearly about {show_country}'s domestic affairs, the location should be in {show_country}. If it's about a foreign country, use that country.
"""


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s or "").strip()


def _build_user_prompt(episode: dict, show: dict) -> str:
    """Build the prompt for the AI model from episode and show data."""
    parts = []
    parts.append(f"Show: {show.get('title', 'Unknown')}")
    parts.append(f"Show author: {show.get('author', 'Unknown')}")
    if show.get('country'):
        parts.append(f"Show country: {show['country']}")
    if show.get('categories'):
        parts.append(f"Show categories: {', '.join(show['categories'])}")
    parts.append(f"Episode title: {episode.get('title', '')}")
    if episode.get('description'):
        parts.append(f"Episode description: {episode['description'][:2000]}")
    if episode.get('summary'):
        parts.append(f"Episode summary: {episode['summary'][:500]}")
    return "\n".join(parts)


def _stream_chat(client: httpx.Client, user_prompt: str) -> str:
    """Stream a chat completion; return the concatenated assistant text.

    Handles both OpenAI-format (data: {"choices":[{"delta":{"content":"..."}}]})
    and legacy XYZO format ({"text":"...", "done": false}).
    """
    payload = {
        "message": AUDIO_EXTRACTION_SYSTEM_PROMPT + "\n\n" + user_prompt,
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
            # Handle SSE format (data: {...})
            for line in buf.split("\n"):
                line = line.strip()
                if not line or line == "data: [DONE]":
                    continue
                # Strip SSE "data: " prefix
                if line.startswith("data: "):
                    line = line[6:]
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict):
                        # OpenAI format: choices[0].delta.content
                        choices = obj.get("choices", [])
                        if choices and isinstance(choices, list):
                            delta = choices[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                full += content
                        # Legacy XYZO format: {"text": "...", "done": false}
                        elif obj.get("text"):
                            full += obj["text"]
                        if obj.get("done"):
                            return full
                except json.JSONDecodeError:
                    continue
            buf = ""
    return full


def _parse_ai_response(raw: str) -> dict | None:
    """Parse the AI's JSON response, stripping markdown fences."""
    text = raw.strip()
    # Strip markdown code fences
    text = re.sub(r'^```(?:json)?\s*\n?', '', text)
    text = re.sub(r'\n?```\s*$', '', text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in the text
        m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
    return None


def extract_episode(client: httpx.Client, episode: dict, show: dict) -> dict | None:
    """Extract structured data from a single episode.

    Returns extraction result dict or None on failure.
    """
    user_prompt = _build_user_prompt(episode, show)

    try:
        raw = _stream_chat(client, user_prompt)
        parsed = _parse_ai_response(raw)
        if not parsed:
            log.warning("audio extract: failed to parse AI response for episode %s", episode.get("id"))
            return None
        return parsed
    except httpx.HTTPError as exc:
        log.warning("audio extract: AI request failed for episode %s: %s", episode.get("id"), exc)
        return None
    except Exception as exc:
        log.warning("audio extract: unexpected error for episode %s: %s", episode.get("id"), exc)
        return None


def apply_extraction(cur, episode_id: int, extraction: dict, source_id: int) -> None:
    """Write extraction results back to audio_episodes."""
    cur.execute(
        """
        UPDATE audio_episodes SET
            location_text = %s,
            event_type = %s,
            entities = %s,
            topic_tags = %s,
            summary = %s,
            hosts = COALESCE(%s, hosts),
            guests = COALESCE(%s, guests),
            status = 'extracted',
            extracted_at = now()
        WHERE id = %s
        """,
        (
            extraction.get("location_text"),
            extraction.get("event_type"),
            extraction.get("entities", []),
            extraction.get("topic_tags", []),
            extraction.get("summary"),
            extraction.get("hosts"),
            extraction.get("guests"),
            episode_id,
        ),
    )


def run(limit: int = 0, progress: ProgressWriter | None = None) -> dict:
    """Main extraction loop. Pulls pending episodes and processes them.

    limit=0 means drain the entire pending queue.
    """
    summary = {"extracted": 0, "failed": 0, "skipped": 0}

    with connect() as conn, conn.cursor() as cur:
        # Fetch pending episodes with their show metadata
        cur.execute("""
            SELECT e.id, e.url, e.title, e.description, e.summary,
                   e.hosts, e.guests,
                   s.id AS show_id, s.title AS show_title,
                   s.author AS show_author, s.country AS show_country,
                   s.categories AS show_categories
            FROM audio_episodes e
            JOIN audio_shows s ON s.id = e.show_id
            WHERE e.status = 'pending'
            ORDER BY e.published_at DESC NULLS LAST
            LIMIT %s
        """, (limit if limit > 0 else 10000,))

        episodes = cur.fetchall()

    if not episodes:
        log.info("audio extract: no pending episodes")
        return summary

    log.info("audio extract: %d pending episodes", len(episodes))

    with httpx.Client(timeout=TIMEOUT_S) as client:
        for ep in episodes:
            episode = {
                "id": ep["id"],
                "url": ep["url"],
                "title": ep["title"],
                "description": ep["description"],
                "summary": ep["summary"],
                "hosts": ep.get("hosts", []),
                "guests": ep.get("guests", []),
            }
            show = {
                "title": ep["show_title"],
                "author": ep["show_author"],
                "country": ep["show_country"],
                "categories": ep.get("show_categories", []),
            }

            extraction = extract_episode(client, episode, show)
            if extraction:
                with connect() as conn, conn.cursor() as cur:
                    apply_extraction(cur, ep["id"], extraction, ep["show_id"])
                    conn.commit()
                summary["extracted"] += 1
                log.debug("audio extract: episode %d extracted", ep["id"])
            else:
                # Mark as failed to avoid retry storms
                with connect() as conn, conn.cursor() as cur:
                    cur.execute(
                        "UPDATE audio_episodes SET status = 'failed', error_message = 'extraction_failed' WHERE id = %s",
                        (ep["id"],),
                    )
                    conn.commit()
                summary["failed"] += 1

            # Rate limit AI requests
            time.sleep(0.5)

    return summary
