"""Language detection for incoming articles.

Runs before city matching so the resolver can prioritize names in the
article's language. Uses langdetect (pure Python, 53 languages) with a
script-detection fallback for languages langdetect doesn't cover
(Urdu, Pashto, etc. that share the Arabic script).

Usage:
    from .lang_detect import detect_language
    lang = detect_language("Текст новости на русском языке")
    # → 'ru'
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Optional

log = logging.getLogger("xyzo.lang_detect")

# Lazy-loaded — langdetect is imported once, then we use detect() directly.
_langdetect_available = None


def _check_langdetect():
    global _langdetect_available
    if _langdetect_available is None:
        try:
            from langdetect import detect as _ld_detect  # noqa: F401
            from langdetect import LangDetectException  # noqa: F401
            # Make detection deterministic
            from langdetect import DetectorFactory
            DetectorFactory.seed = 0
            _langdetect_available = True
        except Exception as e:
            log.warning("langdetect init failed: %s", e)
            _langdetect_available = False
    return _langdetect_available


# ── Script detection fallback ────────────────────────────────────────
# Unicode block ranges for major scripts. Used when langdetect fails
# or returns low-confidence results.

SCRIPT_RANGES = [
    # (script_name, start_cp, end_cp, default_lang)
    ("Arabic", 0x0600, 0x06FF, "ar"),
    ("Arabic", 0x0750, 0x077F, "ar"),      # Arabic Supplement
    ("Arabic", 0xFB50, 0xFDFF, "ar"),      # Arabic Presentation Forms-A
    ("Arabic", 0xFE70, 0xFEFF, "ar"),      # Arabic Presentation Forms-B
    ("Devanagari", 0x0900, 0x097F, "hi"),
    ("Bengali", 0x0980, 0x09FF, "bn"),
    ("Gurmukhi", 0x0A00, 0x0A7F, "pa"),
    ("Gujarati", 0x0A80, 0x0AFF, "gu"),
    ("Tamil", 0x0B80, 0x0BFF, "ta"),
    ("Telugu", 0x0C00, 0x0C7F, "te"),
    ("Kannada", 0x0C80, 0x0CFF, "kn"),
    ("Malayalam", 0x0D00, 0x0D7F, "ml"),
    ("Sinhala", 0x0D80, 0x0DFF, "si"),
    ("Thai", 0x0E00, 0x0E7F, "th"),
    ("Lao", 0x0E80, 0x0EFF, "lo"),
    ("Tibetan", 0x0F00, 0x0FFF, "bo"),
    ("Myanmar", 0x1000, 0x109F, "my"),
    ("Georgian", 0x10A0, 0x10FF, "ka"),
    ("Hangul", 0xAC00, 0xD7AF, "ko"),
    ("HangulJamo", 0x1100, 0x11FF, "ko"),
    ("CJK", 0x4E00, 0x9FFF, "zh"),
    ("CJK", 0x3400, 0x4DBF, "zh"),         # CJK Extension A
    ("Hiragana", 0x3040, 0x309F, "ja"),
    ("Katakana", 0x30A0, 0x30FF, "ja"),
    ("Ethiopic", 0x1200, 0x137F, "am"),
    ("Hebrew", 0x0590, 0x05FF, "he"),
    ("Armenian", 0x0530, 0x058F, "hy"),
    ("Cyrillic", 0x0400, 0x04FF, None),     # Disambiguated by langdetect
    ("Greek", 0x0370, 0x03FF, "el"),
]

# Urdu vs Arabic vs Persian disambiguation by character frequency.
# Urdu uses specific characters not found in Arabic or Persian.
URDU_MARKERS = set("ڑژںھٹڈثےۓؤٗ")
PERSIAN_MARKERS = set("پچڤگ")
ARABIC_MARKERS = set("ء")


def _detect_script(text: str) -> tuple[str, str | None]:
    """Detect the dominant script in text. Returns (script_name, default_lang)."""
    if not text:
        return ("Latin", None)

    script_counts: dict[str, int] = {}
    for ch in text:
        cp = ord(ch)
        for script_name, start, end, _ in SCRIPT_RANGES:
            if start <= cp <= end:
                script_counts[script_name] = script_counts.get(script_name, 0) + 1
                break

    if not script_counts:
        return ("Latin", None)

    dominant = max(script_counts, key=script_counts.get)
    default_lang = None
    for script_name, _, _, lang in SCRIPT_RANGES:
        if script_name == dominant and lang:
            default_lang = lang
            break
    return (dominant, default_lang)


def _disambiguate_arabic_script(text: str) -> str:
    """Distinguish Urdu/Persian/Arabic by character frequency analysis.

    All three share most Arabic letters, but each has distinctive chars:
    - Urdu: ں ے ڑ ژ ٹ ڈ (very strong signal)
    - Persian: گ چ پ + high frequency of ی and ک (U+06A9 KEHEH)
    - Arabic: uses ك (U+0643 KAF) not ک (U+06A9 KEHEH)
    """
    chars = set(text)
    char_list = list(text)

    # Urdu-specific letters (very strong signal)
    urdu_only = set("ڑژںٹڈ")
    # Urdu high-frequency letters (strong signal)
    urdu_common = set("ےۓؤ")
    # Persian-only letters
    persian_only = set("پچڤگ")

    urdu_score = len(chars & urdu_only) * 3 + len(chars & urdu_common) * 2
    persian_score = len(chars & persian_only) * 3

    # Frequency of ک (U+06A9 KEHEH) — Persian/Urdu, NOT standard Arabic
    keheh_count = char_list.count("ک")
    # Frequency of Arabic kaf (U+0643) — Arabic, NOT Persian/Urdu
    kaf_count = char_list.count("ك")

    # If we have Arabic kaf and no keheh, likely Arabic
    if kaf_count > 0 and keheh_count == 0:
        return "ar"

    # Urdu has very distinctive markers
    if urdu_score >= 3:
        return "ur"

    # Persian signal: keheh + persian-only chars
    persian_score += keheh_count

    if persian_score > urdu_score:
        return "fa"
    if urdu_score > 0:
        return "ur"

    # Default to Arabic if no strong signal either way
    return "ar"


# ── Public API ───────────────────────────────────────────────────────

def detect_language(text: str, min_length: int = 10) -> Optional[str]:
    """Detect the language of text. Returns ISO 639-1 code or None.

    Strategy:
    1. If text is too short, return None (not enough signal).
    2. Try langdetect first (covers 53 languages, high accuracy).
    3. If langdetect fails or returns low-confidence, fall back to
       script detection (covers Urdu, Pashto, and other languages
       langdetect doesn't handle well).
    4. For Arabic-script text, disambiguate Urdu/Persian/Arabic.
    """
    if not text or len(text.strip()) < min_length:
        return None

    # Clean up: strip HTML tags, URLs, excessive whitespace
    clean = re.sub(r"<[^>]+>", " ", text)
    clean = re.sub(r"https?://\S+", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()

    if len(clean) < min_length:
        return None

    # Try langdetect
    lang = None
    if _check_langdetect():
        try:
            from langdetect import detect as ld_detect, LangDetectException
            lang = ld_detect(clean)
        except LangDetectException:
            pass
        except Exception:
            pass

    # Script-based detection — takes priority for non-Latin scripts
    # because langdetect often confuses Arabic-script languages
    # (Urdu/Persian/Arabic) and short CJK text.
    script, script_lang = _detect_script(clean)

    if script == "Arabic":
        # Use markers if they give strong evidence, otherwise trust langdetect.
        # Markers can definitively identify Urdu ( distinctive letters),
        # but Persian text without rare chars looks like Arabic to markers.
        disambiguated = _disambiguate_arabic_script(clean)
        if disambiguated == "ur":
            return "ur"  # Urdu markers are definitive
        if disambiguated == "fa" and lang in ("fa", "ar"):
            return "fa"  # Persian markers + langdetect agreement
        # No strong marker signal — trust langdetect if it picked Arabic-script lang
        if lang in ("fa", "ur", "ar"):
            return lang
        return disambiguated

    if script in ("Hiragana", "Katakana"):
        return "ja"

    if script == "Hangul" or script == "HangulJamo":
        return "ko"

    if script == "CJK":
        # CJK-only: could be Chinese or Japanese (kanji).
        # If langdetect says Japanese, trust it; otherwise Chinese.
        if lang == "ja":
            return "ja"
        return "zh"

    # For Cyrillic, Greek, and other scripts langdetect handles well,
    # trust langdetect if it succeeded.
    if lang:
        return lang

    # Fallback to script default
    if script_lang:
        return script_lang

    # Latin script with no langdetect result — default to English
    if script == "Latin":
        return "en"

    return None


def detect_language_batch(texts: list[str]) -> list[str | None]:
    """Detect languages for a batch of texts."""
    return [detect_language(t) for t in texts]


def detect_and_store(article_id: int, title: str, body: str = "") -> str | None:
    """Detect language and store on the article. Returns the detected code."""
    text = f"{title or ''} {(body or '')[:500]}"
    lang = detect_language(text)
    if lang:
        from .db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE news_articles SET detected_lang = %s WHERE id = %s",
                (lang, article_id),
            )
    return lang
