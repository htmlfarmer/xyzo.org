#!/usr/bin/env python3
"""Extract claims from article text.

Claims convert text into structured propositions:

"Tesla will build a new factory in Texas"

becomes:

{
  "subject": "Tesla",
  "predicate": "build",
  "object": "factory",
  "location": "Texas",
  "time": "future",
  "certainty": "planned"
}

This is the foundation for the knowledge graph.

Usage:
    python -m worker.extract_claims                    # full extraction
    python -m worker.extract_claims --limit 1000       # limit
"""

import argparse
import logging
import re
from dataclasses import dataclass
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_claims")

# Claim patterns: (pattern, predicate, certainty_base)
# Each pattern should capture: subject, predicate/action, and optionally object/location
CLAIM_PATTERNS = [
    # Kill/injure patterns - check first since they're specific
    (r'killed\s+(?:at\s+least\s+)?(\d+)\s+(?:people|residents|citizens)?', 'killed', 'confirmed'),
    (r'(\d+)\s+(?:people|residents|citizens)\s+(?:were\s+)?(?:killed|dead)', 'killed', 'confirmed'),
    (r'injured\s+(?:at\s+least\s+)?(\d+)\s+(?:people|residents)?', 'injured', 'confirmed'),
    (r'(\d+)\s+(?:people|residents)\s+(?:were\s+)?(?:injured|wounded)', 'injured', 'confirmed'),
    
    # Announce/intend patterns
    (r'(\w+(?:\s+\w+)?)\s+(?:will|will\s+be|shall)\s+(?:plan\s+to\s+)?(\w+(?:\s+\w+){0,3})\s+(?:in|at|near)\s+(\w+)', 'announce_future', 'planned'),
    (r'(\w+(?:\s+\w+)?)\s+(?:announced|announced\s+plans?)\s+(?:to\s+)?(\w+(?:\s+\w+){0,3})', 'announced', 'confirmed'),
    (r'(\w+(?:\s+\w+)?)\s+(?:plans?|intends?|expects?)\s+(?:to\s+)?(\w+(?:\s+\w+){0,3})', 'plans', 'planned'),
    
    # Create/build patterns
    (r'(\w+(?:\s+\w+)?)\s+(?:will\s+)?(?:create|build|establish|launch)\s+(\w+(?:\s+\w+){0,3})', 'create', 'planned'),
    (r'(\w+(?:\s+\w+)?)\s+(?:created|built|established|launched)\s+(\w+(?:\s+\w+){0,3})', 'created', 'confirmed'),
    
    # Invest/spend patterns
    (r'(\w+(?:\s+\w+)?)\s+(?:will\s+)?(?:invest|spend|donate)\s+\$?([\d,\.]+(?:\s*(?:billion|million|thousand))?)', 'invest', 'planned'),
    (r'(\w+(?:\s+\w+)?)\s+(?:invested|spent|donated)\s+\$?([\d,\.]+(?:\s*(?:billion|million|thousand))?)', 'invested', 'confirmed'),
    
    # Approve/reject patterns
    (r'(\w+(?:\s+\w+)?)\s+(?:approved|accepted)\s+(\w+(?:\s+\w+){0,3})', 'approved', 'confirmed'),
    (r'(\w+(?:\s+\w+)?)\s+(?:rejected|denied|refused)\s+(\w+(?:\s+\w+){0,3})', 'rejected', 'confirmed'),
    
    # Increase/decrease patterns
    (r'(\w+(?:\s+\w+)?)\s+(?:increased|rose|grew)\s+(?:by\s+)?([\d,\.]+%?)', 'increase', 'confirmed'),
    (r'(\w+(?:\s+\w+)?)\s+(?:decreased|fell|declined)\s+(?:by\s+)?([\d,\.]+%?)', 'decrease', 'confirmed'),
    
    # Say patterns (attributed claims)
    (r'(\w+(?:\s+\w+)?)\s+(?:said|stated)\s+(?:that\s+)?(.+)', 'said', 'reported'),
    (r'(?:According to|per|via)\s+(\w+(?:\s+\w+)?)[,\s]+(.+)', 'according_to', 'reported'),
    
    # Agreement patterns
    (r'(\w+(?:\s+\w+)?)\s+(?:agreed|signed)\s+(?:to|with)\s+(\w+)', 'agreed', 'confirmed'),
]

# Certainty levels
CERTAINTY_LEVELS = {
    'confirmed': 0.9,
    'reported': 0.75,
    'planned': 0.6,
    'predicted': 0.5,
    'alleged': 0.3,
    'speculated': 0.2,
}


@dataclass
class Claim:
    subject: str
    predicate: str
    obj: str
    location: Optional[str] = None
    quantity: Optional[str] = None
    certainty: str = 'reported'
    attribution: Optional[str] = None
    
    def to_dict(self) -> dict:
        return {
            'subject': self.subject,
            'predicate': self.predicate,
            'object': self.obj,
            'location': self.location,
            'quantity': self.quantity,
            'certainty': self.certainty,
            'attribution': self.attribution,
        }


def extract_claims(text: str) -> list:
    """Extract claims from text."""
    claims = []
    seen = set()
    
    # Clean text
    text = re.sub(r'\s+', ' ', text)  # Normalize whitespace
    
    for pattern, pred, default_certainty in CLAIM_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            groups = match.groups()
            
            # Handle patterns where subject is implicit (e.g., "killed 47 people")
            if pred in ('killed', 'injured') and len(groups) >= 1:
                # Subject is the disaster/event type
                subject = 'disaster'  # Generic subject
                obj = groups[0].strip() if groups[0] else ''
            else:
                if len(groups) < 2:
                    continue
                subject = groups[0].strip() if groups[0] else ''
                obj = groups[1].strip() if len(groups) > 1 and groups[1] else ''
            
            predicate = pred
            location = None
            
            # Extract location if present
            if len(groups) > 2 and groups[2]:
                location = groups[2].strip()
            
            # Skip very short subjects/objects
            if len(subject) < 2 or len(obj) < 2:
                continue
            
            # Create unique key to avoid duplicates
            key = f"{subject}|{predicate}|{obj}"
            if key in seen:
                continue
            seen.add(key)
            
            # Determine certainty
            certainty = CERTAINTY_LEVELS.get(default_certainty, 0.5)
            
            # Check for attribution markers
            attribution = None
            if predicate in ('said', 'according_to', 'reported'):
                if 'according to' in match.group(0).lower():
                    attribution = 'third_party'
                elif 'officials' in subject.lower():
                    attribution = 'official'
                elif 'company' in subject.lower() or 'firm' in subject.lower():
                    attribution = 'company'
                else:
                    attribution = 'unnamed'
            
            claims.append(Claim(
                subject=subject,
                predicate=predicate,
                obj=obj,
                location=location,
                certainty=default_certainty,
                attribution=attribution,
            ))
    
    return claims


def aggregate_claims(claims: list) -> dict:
    """Aggregate claims into structured features."""
    if not claims:
        return {
            'claims': [],
            'claim_count': 0,
            'factual_claims': 0,
            'opinion_claims': 0,
            'attributed_claims': 0,
            'anonymous_claims': 0,
            'claim_types': {},
            'subjects': [],
        }
    
    claim_dicts = [c.to_dict() for c in claims]
    
    # Count by type
    claim_types = {}
    for c in claims:
        claim_types[c.predicate] = claim_types.get(c.predicate, 0) + 1
    
    # Count certainty levels
    factual = sum(1 for c in claims if CERTAINTY_LEVELS.get(c.certainty, 0.5) >= 0.6)
    opinion = len(claims) - factual
    
    # Attribution stats
    attributed = sum(1 for c in claims if c.attribution)
    anonymous = sum(1 for c in claims if c.attribution == 'unnamed')
    
    # Unique subjects
    subjects = list(set(c.subject for c in claims))[:20]  # Top 20
    
    return {
        'claims': claim_dicts[:50],  # Limit to top 50 claims
        'claim_count': len(claims),
        'factual_claims': factual,
        'opinion_claims': opinion,
        'attributed_claims': attributed,
        'anonymous_claims': anonymous,
        'claim_types': claim_types,
        'subjects': subjects,
    }


def extract_claim_features(text: str) -> dict:
    """Extract all claim features from article text."""
    claims = extract_claims(text)
    return aggregate_claims(claims)


def process_batch(limit: int = 1000, dry_run: bool = False) -> dict:
    """Process a batch of articles."""
    with connect() as conn:
        rows = conn.execute("""
            SELECT a.id, a.title, a.summary, a.body
            FROM news_articles a
            WHERE a.status = 'extracted'
            AND a.id NOT IN (
                SELECT article_id 
                FROM article_facts 
                WHERE claim_features IS NOT NULL
            )
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,)).fetchall()
    
    processed = 0
    for row in rows:
        try:
            text = f"{row['title'] or ''} {row['summary'] or ''} {row['body'] or ''[:2000]}"
            features = extract_claim_features(text)
            
            if not dry_run:
                with connect() as conn:
                    conn.execute("""
                        INSERT INTO article_facts (article_id, claim_features)
                        VALUES (%s, %s)
                        ON CONFLICT (article_id) DO UPDATE SET
                            claim_features = EXCLUDED.claim_features
                    """, (row['id'], features))
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['id'], e)
    
    return {'processed': processed, 'total': len(rows)}


def main():
    parser = argparse.ArgumentParser(description="Extract claims from articles")
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
