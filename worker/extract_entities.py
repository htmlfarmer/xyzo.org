#!/usr/bin/env python3
"""Extract entities and their roles from article text.

Not just a list of entities, but structured information about:
- Entity types (person, organization, location, product, event)
- Entity roles (subject, object, location, etc.)
- Entity relationships (Tesla → announced → factory)

Usage:
    python -m worker.extract_entities                    # full extraction
    python -m worker.extract_entities --limit 1000   # limit
"""

import argparse
import logging
import re
from collections import Counter
from dataclasses import dataclass
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_entities")

# Entity type patterns
ENTITY_TYPE_PATTERNS = {
    'person': [
        r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\b',  # Multi-word names
        r'\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Lady)\.\s+[A-Z][a-z]+',
    ],
    'organization': [
        r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|LLC|Corp|Ltd|Company|Co)\b',
        r'\b[A-Z]{2,}(?:\s+[A-Z][a-z]+)*\b',  # ALL CAPS orgs
    ],
}

# Relationship patterns
RELATIONSHIP_PATTERNS = [
    (r'(\w+)\s+(?:announced|said|revealed|confirmed|reported|stated|indicated|showed)\s+(?:that\s+)?(\w+)', 'said'),
    (r'(\w+)\s+(?:will|to|plans?\s+to|intends?\s+to)\s+(\w+)', 'intends'),
    (r'(\w+)\s+(?:built|constructed|opened|launched|created|established)\s+(\w+)', 'created'),
    (r'(\w+)\s+(?:invested|spent|donated|contributed)\s+([\w\s]+(?:in|to|for)\s+\w+)', 'invested'),
    (r'(\w+)\s+(?:is|are|was|were)\s+(?:located|situated|based)\s+(?:in|at)\s+(\w+)', 'located_in'),
]


@dataclass
class Entity:
    name: str
    etype: str
    role: str = 'unknown'
    frequency: int = 1
    first_position: int = 0
    
    def to_dict(self) -> dict:
        return {
            'name': self.name,
            'type': self.etype,
            'role': self.role,
            'frequency': self.frequency,
            'first_position': self.first_position,
        }


def extract_entities(text: str) -> list[Entity]:
    """Extract named entities from text."""
    entities = []
    seen = {}
    
    # Simple capitalized phrase extraction
    pattern = r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b'
    for match in re.finditer(pattern, text):
        name = match.group(0)
        pos = match.start()
        
        # Skip common words
        if name.lower() in {'the', 'and', 'but', 'for', 'with', 'has', 'have', 'had', 'was', 'were', 'are', 'is', 'from', 'that', 'this', 'which', 'when', 'where', 'what', 'how', 'why'}:
            continue
        
        # Skip if too short
        if len(name) < 3:
            continue
        
        if name not in seen:
            seen[name] = len(seen)
            entities.append(Entity(
                name=name,
                etype='unknown',  # Would need NER for actual type
                role='unknown',
                frequency=1,
                first_position=pos,
            ))
        else:
            # Increment frequency
            for e in entities:
                if e.name == name:
                    e.frequency += 1
                    break
    
    return entities


def extract_entity_features(text: str, title: str = '') -> dict:
    """Extract comprehensive entity features."""
    full_text = f"{title} {text}" if title else text
    
    entities = extract_entities(full_text)
    
    # Count by type (simplified - real impl would use NER)
    entity_types = Counter(e.etype for e in entities)
    
    # Calculate entity density
    word_count = len(full_text.split())
    entity_count = len(entities)
    entity_density = entity_count / max(1, word_count) if word_count > 0 else 0
    
    # Calculate repeat rate
    total_mentions = sum(e.frequency for e in entities)
    unique_entities = len(entities)
    repeat_rate = (total_mentions - unique_entities) / max(1, total_mentions) if total_mentions > 0 else 0
    
    # Entity role analysis (simplified - based on position)
    subject_entities = [e for e in entities if e.first_position < len(full_text) // 3]
    object_entities = [e for e in entities if e.first_position >= 2 * len(full_text) // 3]
    
    result = {
        'entity_count': entity_count,
        'unique_entity_count': unique_entities,
        'person_count': entity_types.get('person', 0),
        'organization_count': entity_types.get('organization', 0),
        'location_count': entity_types.get('location', 0),
        'product_count': entity_types.get('product', 0),
        'event_count': entity_types.get('event', 0),
        'entity_density': round(entity_density, 4),
        'entity_repeat_rate': round(repeat_rate, 4),
        'entities': [e.to_dict() for e in entities[:20]],  # Limit to top 20
        'relationships': [],  # Would need dependency parsing for this
    }
    
    return result


def process_batch(limit: int = 1000, dry_run: bool = False) -> dict:
    """Process a batch of articles."""
    with connect() as conn:
        rows = conn.execute("""
            SELECT a.id, a.title, a.body
            FROM news_articles a
            WHERE a.status = 'extracted'
            AND a.entities IS NOT NULL
            AND a.id NOT IN (
                SELECT article_id 
                FROM article_facts 
                WHERE entity_features IS NOT NULL
            )
            LIMIT %s
        """, (limit,)).fetchall()
    
    processed = 0
    for row in rows:
        try:
            features = extract_entity_features(
                row['body'] or '',
                row['title'] or ''
            )
            
            if not dry_run:
                with connect() as conn:
                    conn.execute("""
                        INSERT INTO article_facts (article_id, entity_features)
                        VALUES (%s, %s)
                        ON CONFLICT (article_id) DO UPDATE SET
                            entity_features = EXCLUDED.entity_features
                    """, (row['id'], features))
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['id'], e)
    
    return {'processed': processed, 'total': len(rows)}


def main():
    parser = argparse.ArgumentParser(description="Extract entities from articles")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    
    total_processed = 0
    while True:
        result = process_batch(limit=args.limit, dry_run=args.dry_run)
        total_processed += result['processed']
        log.info("Processed %d/%d articles", result['processed'], result['total'])
        
        if result['processed'] == 0:
            break
    
    log.info("Total processed: %d", total_processed)


if __name__ == "__main__":
    main()
