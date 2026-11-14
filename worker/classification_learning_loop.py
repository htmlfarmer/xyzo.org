"""Continuous News Story Classification & Learning Loop for Xyzo.

Supports both:
1. Fast statistical & Neural Network classification from word frequencies (WITHOUT AI).
2. Active learning loop using AI study queue & LLM classification (WITH AI).
3. User & Admin correction feedback integration from the live map.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

# Ensure database URL is loaded if run standalone
if not os.environ.get("XYZO_DB_DSN") and not os.environ.get("XYZO_DB_URL"):
    env_file = Path(__file__).resolve().parent.parent / "api" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

from .db import connect
from .nn_classifier import WordFrequencyClassifier, get_classifier, SUBTYPE_TO_BUCKET

log = logging.getLogger("xyzo.learning_loop")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

AI_CHAT_URL = os.environ.get("XYZO_AI_CHAT_URL", "http://192.168.1.3:8888/chat/stream")
AI_TIMEOUT_S = float(os.environ.get("XYZO_AI_TIMEOUT", 25))
SAFE_HEADERS = {"X-MCP-Safe": "true"}

CANONICAL_CATEGORIES = [
    "politics", "business", "technology", "crime", "weather", "science",
    "sports", "culture", "environment", "conflict", "health", "disaster",
    "transit", "education", "other"
]


def classify_unclassified_articles(
    batch_size: int = 500,
    max_articles: int = 25000,
    min_confidence: float = 0.45,
    located_only: bool = False,
) -> dict[str, int]:
    """Classify unclassified articles in news_articles using the NN classifier.

    Runs pure Python + PyTorch inference on word_freq & titles without calling external AI.
    """
    clf = get_classifier()
    if not clf.is_loaded:
        log.info("Classifier not loaded; attempting to load latest model...")
        if not clf.load():
            log.info("No trained model found. Training initial model...")
            clf.train()

    stats = {
        "scanned": 0,
        "classified_high": 0,
        "classified_medium": 0,
        "classified_low": 0,
        "sent_to_ai_queue": 0,
        "updated": 0,
    }

    t0 = time.time()
    log.info("Scanning for unclassified articles (max=%d, batch=%d, min_conf=%.2f)...",
             max_articles, batch_size, min_confidence)

    location_filter = "AND location_id IS NOT NULL" if located_only else ""

    with connect() as conn:
        cur = conn.cursor()
        cur.execute(f"""
            SELECT id, title, summary, event_type, word_freq, location_id
            FROM news_articles
            WHERE (event_type IS NULL OR event_type IN ('other', 'news', 'none', ''))
              AND word_freq IS NOT NULL
              {location_filter}
            ORDER BY (location_id IS NOT NULL) DESC, fetched_at DESC
            LIMIT %s;
        """, (max_articles,))
        rows = cur.fetchall()

    if not rows:
        log.info("No unclassified articles found to process.")
        return stats

    stats["scanned"] = len(rows)
    log.info("Fetched %d unclassified articles for classification pass.", len(rows))

    updates: list[tuple[str, str, str, int]] = []
    ai_candidates: list[dict] = []

    # Process in batches of 1000 for high GPU throughput
    chunk_size = 1000
    for c_start in range(0, len(rows), chunk_size):
        chunk = rows[c_start:c_start + chunk_size]
        preds = clf.predict_batch(chunk)
        for r, pred in zip(chunk, preds):
            cat = pred["category"]
            bucket = pred["bucket"]
            conf = pred["confidence"]

            chosen_cat = cat if cat in SUBTYPE_TO_BUCKET else bucket

            if conf >= 0.70:
                stats["classified_high"] += 1
                updates.append((chosen_cat, "nn_word_freq", "high", r["id"]))
            elif conf >= 0.40:
                stats["classified_medium"] += 1
                updates.append((chosen_cat, "nn_word_freq", "medium", r["id"]))
            elif conf >= min_confidence:
                stats["classified_low"] += 1
                updates.append((chosen_cat, "nn_word_freq", "low", r["id"]))
            else:
                stats["sent_to_ai_queue"] += 1
                ai_candidates.append(r)

    # Batch update database in chunks
    if updates:
        log.info("Applying %d NN category updates to database...", len(updates))
        with connect() as conn:
            cur = conn.cursor()
            for u_start in range(0, len(updates), 2000):
                u_chunk = updates[u_start:u_start + 2000]
                cur.executemany("""
                    UPDATE news_articles
                    SET event_type = %s,
                        auto_categorize_method = %s,
                        auto_categorize_confidence = %s,
                        auto_categorized_at = now()
                    WHERE id = %s;
                """, u_chunk)
            conn.commit()
        stats["updated"] = len(updates)
        log.info("Successfully updated %d articles in %.2fs!", len(updates), time.time() - t0)

    return stats


def ask_ai_categorize(title: str, summary: str = "", top_words: list[str] | None = None) -> tuple[str, str, float]:
    """Query local AI endpoint to categorize a story."""
    words_str = ", ".join(top_words[:12]) if top_words else ""
    prompt = f"""You are a professional news classifier for the global news map xyzo.org.
Analyze this news headline and details, then classify it into exactly ONE of the following categories:
- politics (government, elections, diplomacy, courts, policy, protests)
- business (markets, economy, companies, real estate, banking, labor, crypto)
- technology (AI, software, computing, tech platforms, telecom, cybersecurity)
- crime (law enforcement, courts, shootings, accidents, investigations)
- weather (severe weather, storms, floods, heatwaves, wildfires)
- science (space, biology, astronomy, research studies, physics)
- sports (all athletics, leagues, games, tournaments, championships)
- culture (film, music, books, food, arts, festivals, history)
- environment (conservation, climate, ecology, wildlife, energy, pollution)
- conflict (war, military, international disputes, defense)
- health (medicine, disease outbreaks, healthcare, hospitals)
- disaster (earthquakes, volcanoes, tsunamis, massive catastrophes)
- transit (trains, flights, public transit, road infrastructure)
- education (schools, universities, academic research)
- other (only if genuinely uncategorizable)

Headline: {title}
Summary: {summary}
Key Words: {words_str}

Respond with ONLY valid JSON:
{{"category": "<chosen_category>", "reason": "<one short sentence why>", "confidence": 0.95}}"""

    payload = {
        "message": prompt,
        "stream": True,
    }

    full = ""
    try:
        with httpx.Client(timeout=AI_TIMEOUT_S) as client:
            with client.stream("POST", AI_CHAT_URL, json=payload, headers=SAFE_HEADERS) as resp:
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
                            break
                        try:
                            obj = json.loads(payload_str)
                        except json.JSONDecodeError:
                            continue
                        delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if delta:
                            full += delta

        # Parse JSON
        m = re.search(r"\{[^{}]*\}", full)
        if m:
            data = json.loads(m.group(0))
            cat = str(data.get("category", "")).lower().strip()
            reason = str(data.get("reason", ""))
            conf = float(data.get("confidence", 0.9))
            if cat in CANONICAL_CATEGORIES or cat in SUBTYPE_TO_BUCKET:
                return cat, reason, conf
    except Exception as e:
        log.warning("AI categorization request failed (%s): %s", AI_CHAT_URL, e)

    return "other", "ai_fallback", 0.0


def run_ai_active_learning_loop(limit: int = 50) -> dict[str, int]:
    """Run AI Active Learning pass on ambiguous or low-confidence articles.

    Sends borderline stories to AI, saves verified labels, and adds them
    to the ground-truth training pipeline to improve the NN classifier.
    """
    stats = {"evaluated": 0, "ai_classified": 0, "errors": 0}

    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, title, summary, word_freq
            FROM news_articles
            WHERE (event_type IS NULL OR event_type IN ('other', 'news'))
              AND location_id IS NOT NULL
            ORDER BY fetched_at DESC
            LIMIT %s;
        """, (limit,))
        candidates = cur.fetchall()

    if not candidates:
        log.info("No candidates found for AI active learning.")
        return stats

    log.info("Running AI active learning loop on %d articles...", len(candidates))

    ai_updates = []
    for c in candidates:
        stats["evaluated"] += 1
        wf = c.get("word_freq") or {}
        top_words = sorted(wf.keys(), key=lambda k: wf[k], reverse=True)[:10]

        cat, reason, conf = ask_ai_categorize(c["title"], c.get("summary") or "", top_words)
        if cat != "other" and conf >= 0.6:
            conf_str = "high" if conf >= 0.75 else "medium"
            stats["ai_classified"] += 1
            ai_updates.append((cat, "ai_study", conf_str, c["id"]))
            log.info("AI classified article #%d as [%s] (conf=%s): %s", c["id"], cat, conf_str, c["title"][:60])
        else:
            stats["errors"] += 1

    if ai_updates:
        with connect() as conn:
            cur = conn.cursor()
            cur.executemany("""
                UPDATE news_articles
                SET event_type = %s,
                    auto_categorize_method = %s,
                    auto_categorize_confidence = %s,
                    auto_categorized_at = now()
                WHERE id = %s;
            """, ai_updates)
            conn.commit()
        log.info("Saved %d AI-classified articles to database!", len(ai_updates))

    return stats


def ingest_user_feedback_and_retrain(min_new_labels: int = 50) -> bool:
    """Ingest user corrections from nn_user_corrections & nn_feedback into training dataset."""
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT count(*) FROM nn_user_corrections
            WHERE correction_type = 'category' AND (used_in_training = FALSE OR used_in_training IS NULL);
        """)
        row = cur.fetchone()
        pending_corrections = row["count"] if row else 0

    log.info("Pending user category corrections: %d", pending_corrections)
    if pending_corrections >= min_new_labels:
        log.info("Triggering incremental retraining with %d user corrections...", pending_corrections)
        clf = WordFrequencyClassifier(version=f"v_{int(time.time())}")
        clf.train()
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE nn_user_corrections
                SET used_in_training = TRUE, used_in_training_at = now()
                WHERE correction_type = 'category' AND (used_in_training = FALSE OR used_in_training IS NULL);
            """)
            conn.commit()
        return True

    return False


def main():
    parser = argparse.ArgumentParser(description="Xyzo News Story Classification & Learning Loop")
    parser.add_argument("--backfill", action="store_true", help="Classify all unclassified articles using NN")
    parser.add_argument("--located-only", action="store_true", help="Only classify located articles (immediate map pins)")
    parser.add_argument("--max", type=int, default=30000, help="Max articles to classify in one pass")
    parser.add_argument("--train", action="store_true", help="Train / retrain the category classifier NN")
    parser.add_argument("--ai-active-learning", action="store_true", help="Run AI active learning loop on borderline stories")
    parser.add_argument("--ai-limit", type=int, default=20, help="Max articles for AI active learning")
    parser.add_argument("--loop", action="store_true", help="Run complete learning loop: NN backfill + AI study + retrain check")

    parser.add_argument("--min-conf", type=float, default=0.25, help="Minimum confidence threshold (default 0.25)")
    args = parser.parse_args()

    if args.train:
        log.info("Training Neural Network Word Frequency Classifier...")
        clf = WordFrequencyClassifier(version=f"v_{int(time.time())}")
        meta = clf.train()
        print(f"Training completed successfully! Bucket accuracy: {meta['bucket_accuracy']*100:.1f}%")
        return

    if args.ai_active_learning:
        log.info("Starting AI active learning pass...")
        stats = run_ai_active_learning_loop(limit=args.ai_limit)
        print("AI Active Learning Stats:", stats)
        return

    if args.backfill:
        log.info("Starting NN classification backfill...")
        stats = classify_unclassified_articles(
            max_articles=args.max,
            min_confidence=args.min_conf,
            located_only=args.located_only
        )
        print("NN Backfill Stats:", stats)
        return

    if args.loop:
        log.info("Running full learning loop...")
        # 1. NN Backfill for located articles first
        nn_stats = classify_unclassified_articles(max_articles=args.max, located_only=True)
        print("NN Located Articles Pass:", nn_stats)

        # 2. AI Active learning on low-confidence items
        ai_stats = run_ai_active_learning_loop(limit=args.ai_limit)
        print("AI Active Learning Pass:", ai_stats)

        # 3. Check for retrain trigger
        retrained = ingest_user_feedback_and_retrain(min_new_labels=25)
        print("Model Retrained:", retrained)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
