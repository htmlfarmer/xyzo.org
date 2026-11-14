"""Video transcript extractor — youtube_transcript_api for XYZO.

WHY youtube_transcript_api instead of yt-dlp?
  yt-dlp can list subtitles but fails to download them due to YouTube
  API errors (400 Bad Request on android player endpoint). The
  youtube_transcript_api library fetches transcripts directly from
  YouTube's internal API without OAuth or video download. It's faster,
  more reliable, and doesn't require ffmpeg.

FLOW:
  video_fetch (status=pending)
    → video_transcript (status=transcribed)
    → video_extract (status=extracted) [currently disabled]

PRIORITY for subtitle selection:
  1. Manual English subtitle
  2. Auto-generated English subtitle
  3. Manual subtitle in any language
  4. Auto-generated subtitle in any language

NON-YouTube videos:
  RSS-based broadcaster videos (Al Jazeera, France 24, CBS, etc.) are
  hosted on broadcaster websites, not YouTube. They don't have YouTube
  transcripts. Their metadata (title, description, thumbnail) is indexed
  but transcripts are not available without downloading the actual video.
"""
import json
import logging
from typing import Optional

from youtube_transcript_api import YouTubeTranscriptApi

from .db import connect

log = logging.getLogger("xyzo.video_transcript")

BATCH_SIZE = 50  # videos per batch


# ── Transcript extraction ────────────────────────────────────────────────

def _build_transcript_text(snippets: list) -> str:
    """Convert transcript snippets to plain text with timestamp markers.

    Deduplicates consecutive identical lines and adds timestamp markers
    every ~30 seconds for context.
    """
    parts = []
    last_text = ""
    chars_since_marker = 0

    for snippet in snippets:
        text = snippet.text.strip()
        if not text or text == last_text:
            continue

        # Add timestamp marker periodically
        start = getattr(snippet, "start", 0)
        if start and chars_since_marker > 800:
            minutes = int(start // 60)
            seconds = int(start % 60)
            parts.append(f"\n[{minutes:02d}:{seconds:02d}] ")
            chars_since_marker = 0

        parts.append(text)
        chars_since_marker += len(text)
        last_text = text

    return " ".join(parts).strip()


def fetch_transcript(video_id: str) -> Optional[str]:
    """Fetch transcript for a YouTube video ID.

    Returns plain text transcript or None if unavailable.
    Tries English first, then any available language.
    """
    try:
        ytt_api = YouTubeTranscriptApi()

        # Try to find English transcript first
        try:
            transcript = ytt_api.fetch(video_id, languages=["en"])
            return _build_transcript_text(transcript.snippets)
        except Exception:
            pass

        # Try any available transcript
        try:
            transcript_list = ytt_api.list(video_id)
            for t in transcript_list:
                try:
                    transcript = ytt_api.fetch(video_id, languages=[t.language_code])
                    return _build_transcript_text(transcript.snippets)
                except Exception:
                    continue
        except Exception:
            pass

        return None

    except Exception as exc:
        log.debug("video_transcript: no transcript for %s: %s", video_id, exc)
        return None


# ── Batch processing ─────────────────────────────────────────────────────

def _claim_transcripts_due(cur, batch_size: int) -> list[dict]:
    """Claim videos that need transcription (status='pending' or 'extracted')."""
    cur.execute("""
        WITH claimable AS (
            SELECT v.id, v.url, v.video_id, v.platform, v.status
            FROM video_items v
            WHERE v.status = 'pending'
              AND v.transcript_available IS NOT TRUE
            ORDER BY v.published_at DESC NULLS LAST, v.id
            LIMIT %s
            FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
            UPDATE video_items
            SET status = 'transcribed'
            FROM claimable
            WHERE video_items.id = claimable.id
            RETURNING video_items.id, video_items.url, video_items.video_id,
                      video_items.platform
        )
        SELECT id, url, video_id, platform FROM claimed ORDER BY id
    """, (batch_size,))
    return cur.fetchall()


def _update_transcript_result(cur, video_db_id: int, transcript_text: Optional[str],
                               error: Optional[str] = None) -> None:
    """Update a video item with transcript data or error."""
    if error:
        cur.execute(
            "UPDATE video_items SET status = 'pending', error_message = %s WHERE id = %s",
            (error, video_db_id),
        )
    elif transcript_text:
        cur.execute(
            """UPDATE video_items
               SET transcript_text = %s,
                   transcript_available = TRUE,
                   transcribed_at = now(),
                   status = 'transcribed',
                   error_message = NULL
               WHERE id = %s""",
            (transcript_text, video_db_id),
        )
    else:
        # No transcript available — mark as transcribed but no text
        cur.execute(
            """UPDATE video_items
               SET transcript_available = FALSE,
                   transcribed_at = now(),
                   status = 'transcribed'
               WHERE id = %s""",
            (video_db_id,),
        )


def run_transcription(batch_size: int = BATCH_SIZE) -> dict:
    """Main entry point: extract transcripts for pending videos."""
    summary = {
        "claimed": 0,
        "transcribed": 0,
        "no_subtitles": 0,
        "errors": 0,
    }

    with connect() as conn, conn.cursor() as cur:
        videos = _claim_transcripts_due(cur, batch_size)

    summary["claimed"] = len(videos)
    if not videos:
        return summary

    log.info("video_transcript: %d videos to transcribe", len(videos))

    for video in videos:
        video_db_id = video["id"]
        video_id = video["video_id"]
        platform = video.get("platform", "youtube")

        try:
            if platform == "youtube" and video_id:
                transcript_text = fetch_transcript(video_id)
            else:
                # Non-YouTube: no transcript extraction yet
                transcript_text = None

            with connect() as conn, conn.cursor() as cur:
                if transcript_text:
                    _update_transcript_result(cur, video_db_id, transcript_text)
                    summary["transcribed"] += 1
                    log.info("video_transcript: %s — %d chars",
                             video_id, len(transcript_text))
                else:
                    _update_transcript_result(cur, video_db_id, None)
                    summary["no_subtitles"] += 1
                    log.debug("video_transcript: %s — no transcript", video_id)
                conn.commit()

        except Exception as exc:
            log.warning("video_transcript: %s failed: %s", video_id, exc)
            with connect() as conn, conn.cursor() as cur:
                _update_transcript_result(cur, video_db_id, None, error=str(exc)[:500])
                conn.commit()
            summary["errors"] += 1

    return summary


# ── CLI entry point ──────────────────────────────────────────────────────

def run() -> dict:
    """Public entry point for the pipeline."""
    return run_transcription()


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run()
    json.dump(result, sys.stdout, default=str)
    sys.stdout.write("\n")
