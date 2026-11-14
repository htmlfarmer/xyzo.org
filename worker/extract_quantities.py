#!/usr/bin/env python3
"""Extract quantities and numeric expressions from article text.

Quantities are often the most information-dense parts of news:
- "$2 billion"
- "47 people"
- "18%"
- "Category 4"
- "120 km"

This worker extracts and normalizes quantities for structured storage.

Usage:
    python -m worker.extract_quantities                    # full extraction
    python -m worker.extract_quantities --limit 1000       # limit
    python -m worker.extract_quantities --dry-run          # count only
"""

import argparse
import logging
import re
import time
from dataclasses import dataclass
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_quantities")

# Quantity patterns - order matters (more specific first)
QUANTITY_PATTERNS = [
    # Money patterns with suffixes (check BEFORE simple $X pattern)
    (r'\$\s*[\d,\.]+\s*(?:billion|million|thousand)?', 'money'),
    (r'USD\s*[\d,\.]+\s*(?:billion|million|thousand)?', 'money'),
    (r'€\s*[\d,\.]+\s*(?:billion|million|thousand)?', 'money'),
    (r'£\s*[\d,\.]+\s*(?:billion|million|thousand)?', 'money'),
    (r'¥\s*[\d,\.]+\s*(?:billion|million|thousand)?', 'money'),
    
    # Simple money pattern (fallback)
    (r'\$[\d,\.]+', 'money'),
    
    # Percentage patterns
    (r'[\d,\.]+\s*%', 'percentage'),
    (r'(\d+(?:\.\d+)?)\s*percent', 'percentage'),
    
    # Magnitude patterns (earthquake, etc) - check before general numbers
    (r'(?:magnitude|mag)\s*(\d+(?:\.\d+)?)', 'magnitude'),
    
    # Count/people patterns
    (r'(\d[\d,\.]*)\s*(?:people|persons|individuals|citizens|residents|victims|injured|killed|dead)', 'people'),
    (r'(\d[\d,\.]*)\s*(?:workers|employees|staff|members|delegates)', 'people'),
    
    # Distance patterns
    (r'(\d[\d,\.]*)\s*(?:km|kilometers?|miles?|meters?|feet)', 'distance'),
    (r'(\d[\d,\.]*)\s*(?:km/h|mph|kmh)', 'speed'),
    
    # Area patterns
    (r'(\d[\d,\.]*)\s*(?:sq\s*km|square\s*km|hectares?|acres)', 'area'),
    
    # Weight patterns
    (r'(\d[\d,\.]*)\s*(?:tons?|kg|kilograms?|pounds?|metric\s*tons)', 'weight'),
    
    # Temperature patterns
    (r'(\d[\d,\.]*)\s*°?[CFK]', 'temperature'),
    
    # Rating/category patterns
    (r'(?:category|class)\s*(\d+)', 'category'),
    (r'(?:rating|score)\s*(\d+(?:\.\d+)?)\s*(?:out of|/\s*10)?', 'rating'),
    
    # General count patterns
    (r'(\d[\d,\.]+)\s*(?:cases|reports|incidents|events|articles|stories)', 'count'),
    (r'(\d[\d,\.]+)\s*(?:companies|organizations|countries|cities)', 'count'),
    (r'(\d[\d,\.]+)\s*(?:years?|months?|weeks?|days?|hours?|minutes?)', 'duration'),
]

# Multipliers for normalization
MONEY_MULTIPLIERS = {
    'billion': 1_000_000_000,
    'million': 1_000_000,
    'thousand': 1_000,
    'k': 1_000,
    'm': 1_000_000,
    'b': 1_000_000_000,
}

UNIT_ALIASES = {
    'km': 'kilometers',
    'miles': 'miles',
    'meters': 'meters',
    'feet': 'feet',
    'kg': 'kilograms',
    'tons': 'metric_tons',
}


@dataclass
class Quantity:
    raw: str
    value: float
    unit: str
    qtype: str
    
    def to_dict(self) -> dict:
        return {
            'raw': self.raw,
            'value': self.value,
            'unit': self.unit,
            'type': self.qtype,
        }


def parse_number(s: str) -> Optional[float]:
    """Parse a number string, handling commas, spaces, and suffixes."""
    s = s.strip().replace(',', '').replace(' ', '')
    
    # Check for suffix multipliers
    for suffix, mult in MONEY_MULTIPLIERS.items():
        if suffix.lower() in s.lower():
            num_part = re.sub(r'[a-zA-Z\s]', '', s)
            try:
                return float(num_part) * mult
            except ValueError:
                return None
    
    # Handle percentage sign
    s = s.replace('%', '')
    
    try:
        return float(s)
    except ValueError:
        return None


def extract_quantities(text: str) -> list[Quantity]:
    """Extract all quantities from text."""
    quantities = []
    seen = set()
    
    for pattern, qtype in QUANTITY_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            raw = match.group(0)
            if raw.lower() in seen:
                continue
            seen.add(raw.lower())
            
            # Extract the numeric part
            num_match = re.search(r'[\d,\.]+', raw)
            if not num_match:
                continue
                
            value = parse_number(num_match.group(0))
            if value is None:
                continue
            
            # Determine unit
            unit = ''
            if qtype == 'money':
                unit = 'USD'
                if '$' in raw:
                    unit = 'USD'
                elif '€' in raw:
                    unit = 'EUR'
                elif '£' in raw:
                    unit = 'GBP'
                elif '¥' in raw:
                    unit = 'JPY'
            elif qtype == 'percentage':
                unit = '%'
            elif qtype == 'distance':
                if 'km' in raw.lower():
                    unit = 'kilometers'
                elif 'mile' in raw.lower():
                    unit = 'miles'
                elif 'meter' in raw.lower():
                    unit = 'meters'
                elif 'feet' in raw.lower():
                    unit = 'feet'
            elif qtype == 'speed':
                if 'km/h' in raw.lower() or 'kmh' in raw.lower():
                    unit = 'km/h'
                else:
                    unit = 'mph'
            elif qtype == 'area':
                unit = 'sq_km'
            elif qtype == 'weight':
                if 'kg' in raw.lower():
                    unit = 'kilograms'
                elif 'pound' in raw.lower():
                    unit = 'pounds'
                else:
                    unit = 'metric_tons'
            elif qtype == 'temperature':
                if 'F' in raw:
                    unit = 'fahrenheit'
                elif 'C' in raw:
                    unit = 'celsius'
                elif 'K' in raw:
                    unit = 'kelvin'
                else:
                    unit = 'celsius'
            elif qtype == 'magnitude':
                unit = 'magnitude'
            elif qtype == 'category':
                unit = 'category'
            elif qtype == 'rating':
                unit = 'rating'
            elif qtype == 'duration':
                if 'year' in raw.lower():
                    unit = 'years'
                elif 'month' in raw.lower():
                    unit = 'months'
                elif 'week' in raw.lower():
                    unit = 'weeks'
                elif 'day' in raw.lower():
                    unit = 'days'
                elif 'hour' in raw.lower():
                    unit = 'hours'
                elif 'minute' in raw.lower():
                    unit = 'minutes'
                else:
                    unit = 'count'
            else:
                unit = qtype
            
            quantities.append(Quantity(
                raw=raw,
                value=value,
                unit=unit,
                qtype=qtype,
            ))
    
    return quantities


def aggregate_quantities(quantities: list[Quantity]) -> dict:
    """Aggregate quantities by type."""
    result = {
        'quantities': [q.to_dict() for q in quantities],
        'quantity_count': len(quantities),
    }
    
    # Aggregate by type
    by_type = {}
    for q in quantities:
        if q.qtype not in by_type:
            by_type[q.qtype] = []
        by_type[q.qtype].append(q.value)
    
    # Sum by type
    if 'money' in by_type:
        result['money_total'] = sum(by_type['money'])
    if 'people' in by_type:
        result['people_total'] = sum(by_type['people'])
    if 'percentage' in by_type:
        result['avg_percentage'] = sum(by_type['percentage']) / len(by_type['percentage'])
    if 'count' in by_type:
        result['count_total'] = sum(by_type['count'])
    
    return result


def extract_for_article(article_id: int, title: str, summary: str = '', body: str = '') -> dict:
    """Extract quantities for a single article."""
    text = f"{title} {summary} {body[:2000]}"  # Limit body length
    
    quantities = extract_quantities(text)
    return aggregate_quantities(quantities)


def process_batch(limit: int = 1000, dry_run: bool = False) -> dict:
    """Process a batch of articles."""
    with connect() as conn:
        # Get articles without quantity features
        rows = conn.execute("""
            SELECT a.id, a.title, a.summary, a.body
            FROM news_articles a
            WHERE a.status = 'extracted'
            AND a.id NOT IN (
                SELECT article_id 
                FROM article_facts 
                WHERE quantity_features IS NOT NULL
            )
            LIMIT %s
        """, (limit,)).fetchall()
    
    processed = 0
    for row in rows:
        try:
            features = extract_for_article(
                row['id'],
                row['title'] or '',
                row['summary'] or '',
                row['body'] or ''
            )
            
            if not dry_run:
                with connect() as conn:
                    conn.execute("""
                        INSERT INTO article_facts (article_id, quantity_features)
                        VALUES (%s, %s)
                        ON CONFLICT (article_id) DO UPDATE SET
                            quantity_features = EXCLUDED.quantity_features
                    """, (row['id'], features))
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['id'], e)
    
    return {'processed': processed, 'total': len(rows)}


def main():
    parser = argparse.ArgumentParser(description="Extract quantities from articles")
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
