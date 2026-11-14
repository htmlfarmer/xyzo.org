#!/usr/bin/env python3
"""Extract attribution features from article text.

Attribution tells us WHERE information comes from:

"According to officials, X"

vs

"The company announced X"

These are epistemically different.

Attribution types:
- official: government officials, police, authorities
- expert: scientists, researchers, analysts
- witness: eyewitnesses, residents, locals
- company: corporate spokespeople, PR
- media: other news outlets
- anonymous: unnamed sources

Usage:
    python -m worker.extract_attribution                    # full extraction
    python -m worker.extract_attribution --limit 1000     # limit
"""

import argparse
import logging
import re
from dataclasses import dataclass
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_attribution")

# Attribution marker patterns
ATTRIBUTION_PATTERNS = [
    # Official sources
    (r'(?:according to|per)\s+(?:(?:the\s+)?(?:government|officials?|authorities?|police|army|military))', 'official'),
    (r'(?:government|official|police|army)\s+(?:said|stated|announced|confirmed|reported)', 'official'),
    (r'(?:minister|secretary|spokesman|spokesperson|governor|mayor|president)\s+(?:said|stated|announced)', 'official'),
    
    # Expert sources
    (r'(?:according to|per)\s+(?:(?:the\s+)?(?:scientists?|researchers?|experts?|analysts?|economists?))', 'expert'),
    (r'(?:scientist|researcher|expert|analyst|professor|doctor)\s+(?:said|stated|found|believes?)', 'expert'),
    (r'(?:according to|per)\s+(?:(?:the\s+)?(?:study|research|analysis|report|survey))', 'expert'),
    
    # Witness sources
    (r'(?:according to|per)\s+(?:(?:the\s+)?(?:witnesses?|residents?|locals?|eyewitnesses?|survivors?))', 'witness'),
    (r'(?:witness|resident|local|survivor|eyewitness)\s+(?:said|described|told)', 'witness'),
    (r'(?:speaking on condition of anonymity|anonymous|source close to)', 'anonymous'),
    
    # Company/corporate sources
    (r'(?:according to|per)\s+(?:(?:the\s+)?(?:company|company official|executive|ceo|spokesperson|corporate))', 'company'),
    (r'(?:the\s+)?(?:company|firm|business|corporation)\s+(?:said|stated|announced|confirmed)', 'company'),
    (r'(?:ceo|chairman|president|executive|vice president)\s+(?:said|stated|told)', 'company'),
    
    # Media sources
    (r'(?:according to|per)\s+(?:(?:the\s+)?(?:newspaper|journal|report|news outlet|media))', 'media'),
    (r'(?:report|news|story|article)\s+(?:said|indicated|suggests?)', 'media'),
    
    # General attribution
    (r'(?:said|stated|announced|reported|confirmed|indicated|suggests?|believes?)\s+(?:that\s+)?', 'general'),
]

# Source role patterns
SOURCE_ROLES = {
    'official': ['government', 'officials', 'authorities', 'police', 'army', 'military', 'minister', 'secretary', 'spokesman', 'governor', 'mayor'],
    'expert': ['scientist', 'researcher', 'expert', 'analyst', 'economist', 'professor', 'doctor', 'study', 'research'],
    'witness': ['witness', 'witnesses', 'resident', 'residents', 'locals', 'eyewitness', 'survivor'],
    'company': ['company', 'executive', 'ceo', 'chairman', 'corporate', 'firm', 'business'],
    'media': ['newspaper', 'journal', 'media', 'news outlet'],
}


@dataclass
class Attribution:
    type: str
    source: Optional[str]
    role: str
    quote_length: int
    is_direct: bool
    
    def to_dict(self) -> dict:
        return {
            'type': self.type,
            'source': self.source,
            'role': self.role,
            'quote_length': self.quote_length,
            'is_direct': self.is_direct,
        }


def extract_quotes(text: str) -> list:
    """Extract quoted text and speaker attribution."""
    quotes = []
    
    # Direct quotes: "text"
    quote_pattern = r'"([^"]+)"'
    for match in re.finditer(quote_pattern, text):
        quote = match.group(1)
        if len(quote) > 10:  # Skip short quotes
            # Try to find attribution before the quote
            before = text[:match.start()].split()[-20:]
            quotes.append({
                'text': quote,
                'is_direct': True,
                'attribution': ' '.join(before) if before else None,
            })
    
    return quotes


def extract_attributions(text: str) -> list:
    """Extract attribution markers from text."""
    attributions = []
    
    # Find attribution markers
    for pattern, atype in ATTRIBUTION_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            matched_text = match.group(0)
            
            # Determine role
            role = 'unknown'
            for r, keywords in SOURCE_ROLES.items():
                if any(kw in matched_text.lower() for kw in keywords):
                    role = r
                    break
            
            attributions.append({
                'type': atype,
                'matched': matched_text,
                'role': role,
            })
    
    return attributions


def count_anonymous_sources(text: str) -> int:
    """Count anonymous/unnamed sources."""
    patterns = [
        r'anonymous',
        r'unnamed',
        r'source close to',
        r'speaking on condition of anonymity',
        r'refused to be named',
        r'not authorized to speak publicly',
    ]
    count = 0
    for p in patterns:
        count += len(re.findall(p, text, re.IGNORECASE))
    return count


def count_official_sources(text: str) -> int:
    """Count official sources (government, police, etc)."""
    patterns = [
        r'government',
        r'officials?',
        r'authorities?',
        r'police',
        r'army',
        r'military',
        r'minister',
        r'secretary',
    ]
    count = 0
    for p in patterns:
        count += len(re.findall(p, text, re.IGNORECASE))
    return count


def count_expert_sources(text: str) -> int:
    """Count expert sources (scientists, researchers, etc)."""
    patterns = [
        r'scientists?',
        r'researchers?',
        r'experts?',
        r'analysts?',
        r'economists?',
        r'professor',
        r'doctor',
    ]
    count = 0
    for p in patterns:
        count += len(re.findall(p, text, re.IGNORECASE))
    return count


def count_witness_sources(text: str) -> int:
    """Count witness sources."""
    patterns = [
        r'witness',
        r'witnesses',
        r'residents?',
        r'locals?',
        r'eyewitness',
        r'survivor',
    ]
    count = 0
    for p in patterns:
        count += len(re.findall(p, text, re.IGNORECASE))
    return count


def extract_attribution_features(text: str) -> dict:
    """Extract all attribution features from article text."""
    attributions = extract_attributions(text)
    quotes = extract_quotes(text)
    
    # Count by type
    attribution_counts = {}
    for a in attributions:
        atype = a['type']
        attribution_counts[atype] = attribution_counts.get(atype, 0) + 1
    
    # Count source roles
    official_count = count_official_sources(text)
    expert_count = count_expert_sources(text)
    witness_count = count_witness_sources(text)
    anonymous_count = count_anonymous_sources(text)
    
    # Attribution markers
    markers = []
    for a in attributions[:20]:  # Limit to top 20
        markers.append({
            'phrase': a['matched'][:50],  # Truncate long phrases
            'type': a['type'],
            'role': a['role'],
        })
    
    # Quote stats
    direct_quotes = [q for q in quotes if q['is_direct']]
    indirect_quotes = len(quotes) - len(direct_quotes)
    
    return {
        'direct_claim_count': indirect_quotes,
        'attributed_claim_count': len(attributions),
        'anonymous_source_count': anonymous_count,
        'official_source_count': official_count,
        'expert_source_count': expert_count,
        'witness_source_count': witness_count,
        'attribution_markers': markers,
        'quote_count': len(quotes),
        'direct_quotes': len(direct_quotes),
        'indirect_quotes': indirect_quotes,
    }


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
                WHERE attribution_features IS NOT NULL
            )
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,)).fetchall()
    
    processed = 0
    for row in rows:
        try:
            text = f"{row['title'] or ''} {row['summary'] or ''} {row['body'] or ''[:2000]}"
            features = extract_attribution_features(text)
            
            if not dry_run:
                with connect() as conn:
                    conn.execute("""
                        INSERT INTO article_facts (article_id, attribution_features)
                        VALUES (%s, %s)
                        ON CONFLICT (article_id) DO UPDATE SET
                            attribution_features = EXCLUDED.attribution_features
                    """, (row['id'], features))
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['id'], e)
    
    return {'processed': processed, 'total': len(rows)}


def main():
    parser = argparse.ArgumentParser(description="Extract attribution features from articles")
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
