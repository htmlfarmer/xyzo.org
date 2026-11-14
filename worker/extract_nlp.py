#!/usr/bin/env python3
"""Unified NLP extraction worker.

This worker processes articles through all NLP extractors:
- Temporal features
- Quantity features  
- Entity features
- Claim features
- Attribution features
- Linguistic features

Usage:
    python -m worker.extract_nlp                    # process all articles
    python -m worker.extract_nlp --limit 100      # limit batch
    python -m worker.extract_nlp --dry-run        # test without writing
    python -m worker.extract_nlp --article-id 123 # single article
"""

import argparse
import json
import logging
import sys
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_nlp")

try:
    from .extract_temporal import extract_temporal_features
    from .extract_quantities import extract_quantities, aggregate_quantities
    from .extract_entities import extract_entity_features
    from .extract_claims import extract_claim_features
    from .extract_attribution import extract_attribution_features
    from .extract_linguistic import extract_linguistic_features
    EXTRACTORS_AVAILABLE = True
except ImportError as e:
    log.warning("Some extractors not available: %s", e)
    EXTRACTORS_AVAILABLE = False


def extract_all_features(article_id: int, title: str, summary: str, body: str) -> dict:
    """Extract all NLP features from an article."""
    # Combine text fields
    text = f"{title or ''} {summary or ''} {body or ''}"
    text_truncated = text[:5000]  # Limit to first 5000 chars for performance
    
    features = {
        'temporal_features': None,
        'quantity_features': None,
        'entity_features': None,
        'claim_features': None,
        'attribution_features': None,
        'linguistic_features': None,
    }
    
    if not EXTRACTORS_AVAILABLE:
        return features
    
    try:
        features['temporal_features'] = extract_temporal_features(text_truncated)
    except Exception as e:
        log.debug("Temporal extraction failed for %d: %s", article_id, e)
    
    try:
        quantities = extract_quantities(text_truncated)
        features['quantity_features'] = aggregate_quantities(quantities)
    except Exception as e:
        log.debug("Quantity extraction failed for %d: %s", article_id, e)
    
    try:
        features['entity_features'] = extract_entity_features(text_truncated)
    except Exception as e:
        log.debug("Entity extraction failed for %d: %s", article_id, e)
    
    try:
        features['claim_features'] = extract_claim_features(text_truncated)
    except Exception as e:
        log.debug("Claim extraction failed for %d: %s", article_id, e)
    
    try:
        features['attribution_features'] = extract_attribution_features(text_truncated)
    except Exception as e:
        log.debug("Attribution extraction failed for %d: %s", article_id, e)
    
    try:
        features['linguistic_features'] = extract_linguistic_features(text_truncated)
    except Exception as e:
        log.debug("Linguistic extraction failed for %d: %s", article_id, e)
    
    return features


def process_batch(limit: int = 100, dry_run: bool = False, batch_size: int = 50, since_hours: int = None) -> dict:
    """Process a batch of articles.

    Args:
        limit: Maximum total articles to process
        dry_run: If True, don't write to database
        batch_size: Articles per batch
        since_hours: If set, only process articles from last N hours
    """
    total_processed = 0
    total_articles = 0

    while True:
        with connect() as conn:
            if since_hours:
                rows = conn.execute("""
                    SELECT a.id, a.title, a.summary, a.body
                    FROM news_articles a
                    WHERE a.status = 'extracted'
                    AND a.fetched_at > NOW() - INTERVAL '%s hours'
                    AND a.id NOT IN (
                        SELECT article_id
                        FROM article_facts
                        WHERE temporal_features IS NOT NULL
                        AND quantity_features IS NOT NULL
                        AND entity_features IS NOT NULL
                        AND claim_features IS NOT NULL
                        AND attribution_features IS NOT NULL
                        AND linguistic_features IS NOT NULL
                    )
                    ORDER BY a.fetched_at DESC
                    LIMIT %s
                """, (since_hours, batch_size)).fetchall()
            else:
                rows = conn.execute("""
                    SELECT a.id, a.title, a.summary, a.body
                    FROM news_articles a
                    WHERE a.status = 'extracted'
                    AND a.id NOT IN (
                        SELECT article_id
                        FROM article_facts
                        WHERE temporal_features IS NOT NULL
                        AND quantity_features IS NOT NULL
                        AND entity_features IS NOT NULL
                        AND claim_features IS NOT NULL
                        AND attribution_features IS NOT NULL
                        AND linguistic_features IS NOT NULL
                    )
                    ORDER BY a.fetched_at DESC
                    LIMIT %s
                """, (batch_size,)).fetchall()
        
        if not rows:
            break
        
        total_articles += len(rows)
        
        for row in rows:
            try:
                features = extract_all_features(row['id'], row['title'], row['summary'], row['body'])
                
                if not dry_run:
                    with connect() as conn:
                        conn.execute("""
                            INSERT INTO article_facts (
                                article_id,
                                temporal_features,
                                quantity_features,
                                entity_features,
                                claim_features,
                                attribution_features,
                                linguistic_features
                            )
                            VALUES (%s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)
                            ON CONFLICT (article_id) DO UPDATE SET
                                temporal_features = COALESCE(EXCLUDED.temporal_features, article_facts.temporal_features),
                                quantity_features = COALESCE(EXCLUDED.quantity_features, article_facts.quantity_features),
                                entity_features = COALESCE(EXCLUDED.entity_features, article_facts.entity_features),
                                claim_features = COALESCE(EXCLUDED.claim_features, article_facts.claim_features),
                                attribution_features = COALESCE(EXCLUDED.attribution_features, article_facts.attribution_features),
                                linguistic_features = COALESCE(EXCLUDED.linguistic_features, article_facts.linguistic_features)
                        """, (
                            row['id'],
                            json.dumps(features['temporal_features']),
                            json.dumps(features['quantity_features']),
                            json.dumps(features['entity_features']),
                            json.dumps(features['claim_features']),
                            json.dumps(features['attribution_features']),
                            json.dumps(features['linguistic_features']),
                        ))
                
                total_processed += 1
                
            except Exception as e:
                log.error("Error processing article %d: %s", row['id'], e)
        
        log.info("Batch complete: %d/%d processed", total_processed, total_articles)
        
        if total_processed >= limit:
            break
    
    return {'processed': total_processed, 'total': total_articles}


def process_single(article_id: int, dry_run: bool = False) -> dict:
    """Process a single article by ID."""
    with connect() as conn:
        row = conn.execute("""
            SELECT id, title, summary, body
            FROM news_articles
            WHERE id = %s
        """, (article_id,)).fetchone()
    
    if not row:
        return {'error': f'Article {article_id} not found'}
    
    features = extract_all_features(row['id'], row['title'], row['summary'], row['body'])
    
    if not dry_run:
        with connect() as conn:
            conn.execute("""
                INSERT INTO article_facts (
                    article_id,
                    temporal_features,
                    quantity_features,
                    entity_features,
                    claim_features,
                    attribution_features,
                    linguistic_features
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (article_id) DO UPDATE SET
                    temporal_features = EXCLUDED.temporal_features,
                    quantity_features = EXCLUDED.quantity_features,
                    entity_features = EXCLUDED.entity_features,
                    claim_features = EXCLUDED.claim_features,
                    attribution_features = EXCLUDED.attribution_features,
                    linguistic_features = EXCLUDED.linguistic_features
            """, (
                row['id'],
                json.dumps(features['temporal_features']),
                json.dumps(features['quantity_features']),
                json.dumps(features['entity_features']),
                json.dumps(features['claim_features']),
                json.dumps(features['attribution_features']),
                json.dumps(features['linguistic_features']),
            ))
    
    return {
        'article_id': article_id,
        'features': {k: v is not None for k, v in features.items()},
    }


def main():
    parser = argparse.ArgumentParser(description="Unified NLP extraction worker")
    parser.add_argument("--limit", type=int, default=1000000)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--article-id", type=int, help="Process single article")
    parser.add_argument("--since-hours", type=int, help="Only process articles from last N hours")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )

    if args.article_id:
        result = process_single(args.article_id, dry_run=args.dry_run)
        log.info("Result: %s", result)
    else:
        result = process_batch(limit=args.limit, dry_run=args.dry_run, batch_size=args.batch_size, since_hours=args.since_hours)
        log.info("Total: %d articles processed", result['processed'])


if __name__ == "__main__":
    main()
