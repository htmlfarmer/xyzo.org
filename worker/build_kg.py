#!/usr/bin/env python3
"""Build knowledge graph from extracted claims.

Extracts subject-predicate-object triples and builds a graph:
- kg_nodes: entities (people, orgs, locations)
- kg_edges: relationships between entities

Usage:
    python -m worker.build_kg                    # build graph
    python -m worker.build_kg --limit 1000       # limit
    python -m worker.build_kg --dry-run          # test
"""

import argparse
import logging
import re
from datetime import datetime

from .db import connect

log = logging.getLogger("xyzo.build_kg")

# Entity type inference patterns
PERSON_PATTERNS = [
    r'\b(mr|ms|mrs|dr|prof|senator|governor|president|ceo|director|manager)\b',
    r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\b',  # Two capitalized words
]

ORG_PATTERNS = [
    r'\b(company|corp|corporation|inc|ltd|llc|association|agency|ministry|department)\b',
    r'\b[A-Z][a-z]+\s+(Corp|Inc|LLC|Association)\b',
]

LOCATION_PATTERNS = [
    r'\b(city|state|country|province|district|region|capital)\b',
    r'\b(in|near|at|around)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b',
]


def infer_entity_type(text: str) -> str:
    """Infer entity type from text."""
    text_lower = text.lower()
    
    if any(re.search(p, text_lower) for p in PERSON_PATTERNS):
        return 'person'
    if any(re.search(p, text_lower) for p in ORG_PATTERNS):
        return 'organization'
    if any(re.search(p, text_lower) for p in LOCATION_PATTERNS):
        return 'location'
    
    # Default based on capitalization
    if text[0].isupper():
        return 'unknown'
    
    return 'unknown'


def extract_claims_from_features(claim_features: dict) -> list:
    """Extract claim triples from claim_features."""
    claims = claim_features.get('claims', [])
    if not isinstance(claims, list):
        return []
    
    triples = []
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        
        subject = claim.get('subject', '')
        predicate = claim.get('predicate', '')
        obj = claim.get('object', '')
        location = claim.get('location')
        certainty = claim.get('certainty', 'reported')
        
        # Filter noise: skip short subjects/objects, articles, common words
        skip_words = {'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'that', 'this', 'it', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must'}
        
        subject_clean = subject.strip().lower()
        obj_clean = obj.strip().lower()
        
        # Skip if subject or object is a stop word or very short
        if not subject or not obj:
            continue
        if len(subject) < 3 or len(obj) < 3:
            continue
        if subject_clean in skip_words or obj_clean in skip_words:
            continue
        # Skip if subject/object starts with common words (likely parsing error)
        if subject_clean.split()[0] in {'and', 'or', 'the', 'a', 'an', 'that', 'this'} if subject_clean.split() else False:
            continue
        if obj_clean.split()[0] in {'and', 'or', 'the', 'a', 'an', 'that', 'this'} if obj_clean.split() else False:
            continue
        
        if subject and predicate and obj:
            triples.append({
                'subject': subject.strip()[:200],
                'predicate': predicate.strip(),
                'object': obj.strip()[:200],
                'location': location.strip() if location else None,
                'certainty': certainty,
            })
    
    return triples


def upsert_node(name: str, entity_type: str, conn) -> int:
    """Insert or update a node, return its ID."""
    # Clean name
    name = ' '.join(name.split())[:200]  # Truncate long names
    
    # Try to get existing
    existing = conn.execute(
        "SELECT id FROM kg_nodes WHERE name = %s AND entity_type = %s",
        (name, entity_type)
    ).fetchone()
    
    if existing:
        # Update last_seen and claim_count
        conn.execute("""
            UPDATE kg_nodes 
            SET last_seen = NOW(), claim_count = claim_count + 1
            WHERE id = %s
        """, (existing['id'],))
        return existing['id']
    
    # Insert new
    result = conn.execute("""
        INSERT INTO kg_nodes (name, entity_type, claim_count)
        VALUES (%s, %s, 1)
        ON CONFLICT (name, entity_type) DO UPDATE SET
            last_seen = NOW(),
            claim_count = kg_nodes.claim_count + 1
        RETURNING id
    """, (name, entity_type))
    
    return result.fetchone()['id']


def process_batch(limit: int = 1000, dry_run: bool = False) -> dict:
    """Process articles and build knowledge graph."""
    processed = 0
    nodes_created = 0
    edges_created = 0
    
    with connect() as conn:
        rows = conn.execute("""
            SELECT 
                af.article_id,
                a.published_at,
                af.claim_features
            FROM article_facts af
            JOIN news_articles a ON a.id = af.article_id
            WHERE af.claim_features IS NOT NULL
            AND jsonb_array_length(af.claim_features->'claims') > 0
            AND af.article_id NOT IN (
                SELECT DISTINCT article_id FROM kg_edges WHERE article_id IS NOT NULL
            )
            ORDER BY a.published_at DESC
            LIMIT %s
        """, (limit,)).fetchall()
    
    for row in rows:
        try:
            article_id = row['article_id']
            published_at = row['published_at']
            claim_features = row['claim_features']
            
            triples = extract_claims_from_features(claim_features)
            
            if not triples:
                continue
            
            for triple in triples:
                # Infer entity types
                subject_type = infer_entity_type(triple['subject'])
                object_type = infer_entity_type(triple['object'])
                
                if dry_run:
                    log.debug("Would create: %s --[%s]--> %s", 
                             triple['subject'], triple['predicate'], triple['object'])
                    nodes_created += 2
                    edges_created += 1
                    continue
                
                with connect() as conn:
                    # Upsert nodes
                    subject_id = upsert_node(triple['subject'], subject_type, conn)
                    object_id = upsert_node(triple['object'], object_type, conn)
                    
                    # Upsert edge
                    try:
                        conn.execute("""
                            INSERT INTO kg_edges (
                                subject_id, predicate, object_id, 
                                article_id, certainty, published_at
                            )
                            VALUES (%s, %s, %s, %s, %s, %s)
                            ON CONFLICT (subject_id, predicate, object_id, article_id) DO NOTHING
                        """, (
                            subject_id,
                            triple['predicate'],
                            object_id,
                            article_id,
                            triple['certainty'],
                            published_at,
                        ))
                        edges_created += 1
                    except Exception as e:
                        log.debug("Edge creation failed: %s", e)
                    
                    nodes_created += 2
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['article_id'], e)
    
    return {
        'processed': processed,
        'nodes_created': nodes_created,
        'edges_created': edges_created,
        'total_rows': len(rows),
    }


def main():
    parser = argparse.ArgumentParser(description="Build knowledge graph from claims")
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    
    total_nodes = 0
    total_edges = 0
    total_processed = 0
    
    while True:
        result = process_batch(limit=args.limit, dry_run=args.dry_run)
        total_processed += result['processed']
        total_nodes += result['nodes_created']
        total_edges += result['edges_created']
        
        log.info("Batch: %d articles, %d nodes, %d edges",
                result['processed'], result['nodes_created'], result['edges_created'])
        
        if result['processed'] == 0:
            break
    
    log.info("Total: %d articles, %d nodes, %d edges",
             total_processed, total_nodes, total_edges)


if __name__ == "__main__":
    main()
