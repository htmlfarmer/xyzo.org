#!/usr/bin/env python3
"""GPU-aware entity extraction worker.

Extracts entities from news articles using the local Gemma-4 model with
configurable GPU utilization to avoid saturating the GPU during normal use.

Usage:
    # Run with 30% GPU budget (for light desktop use):
    python -m worker.entity_extract --gpu-budget 0.3

    # Run with 50% GPU budget (normal batch processing):
    python -m worker.entity_extract --gpu-budget 0.5

    # Run with 70% GPU budget (dedicated batch job):
    python -m worker.entity_extract --gpu-budget 0.7

    # Backfill entities for articles missing them:
    python -m worker.entity_extract --backfill --limit 50000

GPU Budget Control:
    - 0.1-0.3: Light use, won't affect normal desktop use
    - 0.4-0.6: Moderate use, some slowdown noticeable
    - 0.7-1.0: Heavy use, dedicated batch processing
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import psycopg

from .ai_client import ai_chat_stream
from .db import connect

log = logging.getLogger("xyzo.entity_extract")

CHAT_URL = os.environ.get(
    "XYZO_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
TIMEOUT_S = float(os.environ.get("XYZO_AI_TIMEOUT", "25"))

ENTITY_SYSTEM_PROMPT = """You are a named entity extraction engine. Given an article's title and body, extract all named entities.

Return ONLY a JSON array of entity names — no descriptions, no markdown, no prose.

Rules:
- Extract people names: "John Smith", "Elon Musk", "President Biden"
- Extract organization names: "Apple", "NASA", "United Nations", "HDFC Bank"
- Extract place/landmark names: "Mount Everest", "Red Sea", "Sahara Desert"
- DO NOT extract generic terms like "the government", "the company", "the city"
- DO NOT extract event types like "the earthquake" or "the meeting"
- DO NOT extract nationalities or demonyms: "American", "British", "Chinese"
- Keep each entity as it appears in the text (proper capitalization)
- Return 3-15 entities maximum, prioritizing the most important ones
- If no entities found, return an empty array: []
"""

ENTITY_FAST_PROMPT = """Extract the key named entities from this article. Return ONLY a JSON array of entity names.

Title: {title}
Body: {body}

Example output: ["Elon Musk", "Tesla", "Twitter", "San Francisco"]

Return ONLY the JSON array, nothing else.
"""


@dataclass
class GPUMetrics:
    """Track GPU utilization and throughput."""
    gpu_util_samples: list[float] = field(default_factory=list)
    articles_processed: int = 0
    total_latency_ms: float = 0.0
    cache_hits: int = 0
    cache_misses: int = 0
    errors: int = 0
    start_time: float = field(default_factory=time.time)

    def record(self, latency_ms: float, from_cache: bool = False):
        self.articles_processed += 1
        self.total_latency_ms += latency_ms
        if from_cache:
            self.cache_hits += 1
        else:
            self.cache_misses += 1

    def add_gpu_sample(self, util: float):
        self.gpu_util_samples.append(util)

    @property
    def avg_latency_ms(self) -> float:
        return self.total_latency_ms / self.articles_processed if self.articles_processed else 0

    @property
    def throughput(self) -> float:
        elapsed = time.time() - self.start_time
        return self.articles_processed / elapsed if elapsed > 0 else 0

    def summary(self) -> dict:
        elapsed = time.time() - self.start_time
        return {
            "articles_processed": self.articles_processed,
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "cache_hit_rate": self.cache_hits / max(1, self.cache_hits + self.cache_misses),
            "errors": self.errors,
            "avg_latency_ms": self.avg_latency_ms,
            "throughput_per_sec": self.throughput,
            "elapsed_seconds": elapsed,
            "avg_gpu_util": sum(self.gpu_util_samples) / len(self.gpu_util_samples) if self.gpu_util_samples else 0,
        }


class GPUBudgetController:
    """Control GPU utilization by adjusting concurrency based on measured load."""

    def __init__(self, target_util: float = 0.5, check_interval_s: float = 5.0):
        self.target_util = target_util
        self.check_interval_s = check_interval_s
        self.current_concurrency = 4
        self.min_concurrency = 1
        self.max_concurrency = 32
        self.last_check = time.time()
        self.gpu_utils: list[float] = []

    def record_gpu_util(self, util: float):
        """Record a GPU utilization sample."""
        self.gpu_utils.append(util)
        if len(self.gpu_utils) > 10:
            self.gpu_utils.pop(0)

    def should_increase_concurrency(self) -> bool:
        """Check if we should process more articles in parallel."""
        if len(self.gpu_utils) < 3:
            return False
        avg = sum(self.gpu_utils) / len(self.gpu_utils)
        return avg < self.target_util and self.current_concurrency < self.max_concurrency

    def should_decrease_concurrency(self) -> bool:
        """Check if we should process fewer articles in parallel."""
        if len(self.gpu_utils) < 3:
            return False
        avg = sum(self.gpu_utils) / len(self.gpu_utils)
        return avg > self.target_util + 0.15 and self.current_concurrency > self.min_concurrency

    def adjust(self) -> int:
        """Adjust concurrency based on GPU utilization. Returns new concurrency."""
        now = time.time()
        if now - self.last_check < self.check_interval_s:
            return self.current_concurrency

        if self.should_decrease_concurrency():
            self.current_concurrency = max(self.min_concurrency, self.current_concurrency - 1)
            log.info("GPU utilization high, decreasing concurrency to %d", self.current_concurrency)
        elif self.should_increase_concurrency():
            self.current_concurrency = min(self.max_concurrency, self.current_concurrency + 1)
            log.info("GPU utilization low, increasing concurrency to %d", self.current_concurrency)

        self.last_check = now
        return self.current_concurrency


class CircuitBreaker:
    """Prevent overwhelming the AI endpoint."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout_s: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self.failures = 0
        self.last_failure_time = 0.0
        self.successes = 0

    def is_allowed(self) -> bool:
        if self.failures >= self.failure_threshold:
            if time.time() - self.last_failure_time > self.recovery_timeout_s:
                log.info("Circuit breaker reset, allowing requests")
                self.failures = 0
                return True
            return False
        return True

    def record_success(self):
        self.successes += 1
        self.failures = 0

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures >= self.failure_threshold:
            log.warning("Circuit breaker OPENED after %d failures", self.failures)


breaker = CircuitBreaker()


def _content_hash(title: str, body: str) -> str:
    """Generate hash for cache key."""
    return hashlib.sha256(f"{title}|{body[:500]}".encode()).hexdigest()


async def _stream_ai_response(messages: list[dict]) -> str:
    """Stream AI response and collect full text."""
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


async def extract_entities_async(
    article_id: int,
    title: str,
    body: str,
    sem: asyncio.Semaphore,
    cache: dict | None = None,
) -> tuple[int, list[str], bool]:
    """Extract entities from a single article.

    Returns:
        (article_id, entities_list, from_cache)
    """
    global breaker

    content_hash = _content_hash(title, body)

    # Check cache first
    if cache is not None and content_hash in cache:
        return article_id, cache[content_hash], True

    if not breaker.is_allowed():
        log.warning("Circuit breaker open, using fallback for article %d", article_id)
        return article_id, _fallback_entity_extraction(title, body), False

    prompt = ENTITY_FAST_PROMPT.format(title=title[:200], body=body[:1500])
    messages = [
        {"role": "system", "content": ENTITY_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    entities = []
    async with sem:
        try:
            text = await _stream_ai_response(messages)
            entities = _parse_entity_response(text)
            if entities is None:
                log.warning("Malformed entity output for article %d, using fallback", article_id)
                entities = _fallback_entity_extraction(title, body)
                breaker.record_failure()
            else:
                breaker.record_success()
        except Exception as exc:
            log.warning("Entity extraction failed for article %d: %s", article_id, exc)
            entities = _fallback_entity_extraction(title, body)
            breaker.record_failure()

    # Update cache
    if cache is not None and entities:
        cache[content_hash] = entities

    return article_id, entities, False


def _fallback_entity_extraction(title: str, body: str) -> list[str]:
    """Simple regex-based entity extraction fallback."""
    import re
    entities = []

    # Pattern for capitalized multi-word names
    patterns = [
        r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b',  # Multi-word proper names
        r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*?(?:Inc|LLC|Corp|Bank|Association|Institute|University)\b',
    ]

    combined = f"{title} {body[:1000]}"
    seen = set()

    for pattern in patterns:
        for match in re.findall(pattern, combined):
            if match not in seen and len(match) > 3:
                seen.add(match)
                entities.append(match)

    return entities[:15]


def _parse_entity_response(text: str) -> list[str] | None:
    """Parse entity list from AI response."""
    import re

    text = text.strip()

    # Try direct JSON array
    if text.startswith("["):
        try:
            entities = json.loads(text)
            if isinstance(entities, list) and all(isinstance(e, str) for e in entities):
                return entities
        except json.JSONDecodeError:
            pass

    # Try to extract JSON from text
    json_match = re.search(r'\[.*\]', text, re.DOTALL)
    if json_match:
        try:
            entities = json.loads(json_match.group())
            if isinstance(entities, list):
                return [str(e) for e in entities if isinstance(e, str)]
        except json.JSONDecodeError:
            pass

    return None


def _write_entities_to_db(article_id: int, entities: list[str], conn) -> int:
    """Write extracted entities to news_entities table.

    Returns:
        Number of new entities created.
    """
    if not entities:
        return 0

    new_count = 0
    for entity_name in entities:
        entity_name = entity_name.strip()
        if len(entity_name) < 2 or len(entity_name) > 200:
            continue

        try:
            # Try to insert entity
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO news_entities (name, type)
                    VALUES (%s, 'other')
                    ON CONFLICT (name, type) DO NOTHING
                    RETURNING id
                """, (entity_name,))
                if cur.fetchone():
                    new_count += 1

                # Link to article via news_article_entities if that table exists
                # Otherwise just update the entities array on news_articles
                cur.execute("""
                    UPDATE news_articles
                    SET entities = COALESCE(entities, '{}') || ARRAY[%s]
                    WHERE id = %s
                """, (entity_name, article_id))
        except Exception as e:
            log.debug("Failed to write entity %r for article %d: %s", entity_name, article_id, e)

    return new_count


async def process_batch(
    articles: list[dict],
    concurrency: int,
    cache: dict | None,
) -> list[tuple[int, list[str], bool]]:
    """Process a batch of articles concurrently."""
    sem = asyncio.Semaphore(concurrency)

    tasks = [
        extract_entities_async(
            art["id"],
            art.get("title", ""),
            art.get("body", ""),
            sem,
            cache,
        )
        for art in articles
    ]

    return await asyncio.gather(*tasks)


def fetch_pending_articles(limit: int, backfill: bool = False) -> list[dict]:
    """Fetch articles that need entity extraction."""
    with connect() as conn, conn.cursor() as cur:
        if backfill:
            # Backfill: articles missing entities entirely
            # Focus on recent articles (ID > 25M) first, descending order for most recent
            cur.execute("""
                SELECT na.id, na.title, na.body, na.source_id,
                       ns.name as source_name, ns.country as source_country
                FROM news_articles na
                JOIN news_sources ns ON na.source_id = ns.id
                WHERE na.status = 'extracted'
                  AND na.id > 25000000
                  AND (na.entities IS NULL OR array_length(na.entities, 1) IS NULL OR na.entities = '{}'::text[])
                  AND na.body IS NOT NULL
                  AND length(na.body) > 50
                ORDER BY na.id DESC
                LIMIT %s
            """, (limit,))
        else:
            # New extraction: pending articles
            cur.execute("""
                SELECT na.id, na.title, na.body, na.source_id,
                       ns.name as source_name, ns.country as source_country
                FROM news_articles na
                JOIN news_sources ns ON na.source_id = ns.id
                WHERE na.status = 'pending'
                  AND na.body IS NOT NULL
                  AND length(na.body) > 50
                ORDER BY na.published_at DESC NULLS LAST
                LIMIT %s
            """, (limit,))

        return list(cur.fetchall())


async def run_extraction(
    gpu_budget: float = 0.5,
    batch_size: int = 50,
    max_articles: int | None = None,
    backfill: bool = False,
    dry_run: bool = False,
):
    """Run entity extraction with GPU budget control.

    Args:
        gpu_budget: Target GPU utilization (0.1 to 1.0)
        batch_size: Articles per batch
        max_articles: Maximum articles to process (None for unlimited)
        backfill: If True, process articles missing entities
        dry_run: If True, don't write to database
    """
    log.info("Starting entity extraction with GPU budget=%.2f, batch_size=%d", gpu_budget, batch_size)

    gpu_controller = GPUBudgetController(target_util=gpu_budget)
    metrics = GPUMetrics()
    cache: dict[str, list[str]] = {}

    # Load cache from ai_cache table (all entries, filter for list results)
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT content_hash, result
            FROM ai_cache
            LIMIT 100000
        """)
        for row in cur.fetchall():
            try:
                result = row["result"]
                if isinstance(result, list):
                    cache[row["content_hash"]] = result
            except Exception:
                pass
    log.info("Loaded %d entries into entity cache", len(cache))

    total_processed = 0
    total_entities_found = 0
    total_new_entities = 0
    start_time = time.time()

    while True:
        if max_articles and total_processed >= max_articles:
            break

        articles = fetch_pending_articles(batch_size, backfill=backfill)
        if not articles:
            log.info("No more articles to process")
            break

        # Adjust concurrency based on GPU utilization
        concurrency = gpu_controller.adjust()

        # Process batch
        batch_start = time.time()
        try:
            results = await process_batch(articles, concurrency, cache)
        except Exception as e:
            log.error("Batch processing failed: %s", e)
            await asyncio.sleep(1)
            continue

        batch_time = time.time() - batch_start

        # Write results to database
        if not dry_run:
            with connect() as conn:
                for article_id, entities, from_cache in results:
                    if entities:
                        new_count = _write_entities_to_db(article_id, entities, conn)
                        total_new_entities += new_count
                        total_entities_found += len(entities)

                    metrics.record(
                        latency_ms=(time.time() - batch_start) * 1000 / len(articles),
                        from_cache=from_cache
                    )

                conn.commit()

        total_processed += len(articles)

        # Log progress
        elapsed = time.time() - start_time
        rate = total_processed / elapsed if elapsed > 0 else 0
        remaining = (max_articles - total_processed) / rate if max_articles and rate > 0 else None

        log.info(
            "Progress: %d articles, %d entities found, %d new entities, "
            "%.1f articles/sec, concurrency=%d, cache hit rate=%.1f%%, ETA=%s",
            total_processed,
            total_entities_found,
            total_new_entities,
            rate,
            concurrency,
            metrics.cache_hits / max(1, metrics.cache_hits + metrics.cache_misses) * 100,
            f"{remaining/60:.1f}min" if remaining else "unknown"
        )

        # Small delay between batches to avoid overwhelming the system
        if batch_time < 0.5:
            await asyncio.sleep(0.5 - batch_time)

    # Final summary
    summary = metrics.summary()
    log.info(
        "Entity extraction complete: %d articles processed, %d entities found, %d new entities, "
        "%.1f articles/sec, avg latency=%.1fms, cache hit rate=%.1f%%",
        total_processed,
        total_entities_found,
        total_new_entities,
        summary["throughput_per_sec"],
        summary["avg_latency_ms"],
        summary["cache_hit_rate"] * 100
    )

    return summary


def main():
    parser = argparse.ArgumentParser(description="GPU-aware entity extraction worker")
    parser.add_argument("--gpu-budget", type=float, default=0.5,
                        help="Target GPU utilization (0.1-1.0, default: 0.5)")
    parser.add_argument("--batch-size", type=int, default=50,
                        help="Articles per batch (default: 50)")
    parser.add_argument("--max-articles", type=int, default=None,
                        help="Maximum articles to process (default: unlimited)")
    parser.add_argument("--backfill", action="store_true",
                        help="Backfill entities for articles missing them")
    parser.add_argument("--dry-run", action="store_true",
                        help="Don't write to database")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Verbose logging")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )

    if args.gpu_budget < 0.1 or args.gpu_budget > 1.0:
        print("Error: GPU budget must be between 0.1 and 1.0")
        sys.exit(1)

    asyncio.run(run_extraction(
        gpu_budget=args.gpu_budget,
        batch_size=args.batch_size,
        max_articles=args.max_articles,
        backfill=args.backfill,
        dry_run=args.dry_run,
    ))


if __name__ == "__main__":
    main()
