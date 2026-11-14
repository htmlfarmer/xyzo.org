#!/usr/bin/env python3
"""Extract temporal features from article text.

This is one of the most important NLP features for news:
- Publication time vs event time are DIFFERENT
- An article published today could describe something from 5 years ago
- Temporal classification (PAST/PRESENT/FUTURE/ONGOING) is vital for trending

Temporal classification:
- PAST: Describes events that happened and completed
- PRESENT: Describes current ongoing events
- FUTURE: Describes planned/expected events
- ONGOING: Events that started in past and continue
- RECURRING: Periodic events (elections, holidays)
- UNKNOWN: Cannot determine temporal context

Usage:
    python -m worker.extract_temporal                    # full extraction
    python -m worker.extract_temporal --limit 1000       # limit
"""

import argparse
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_temporal")

# Date patterns
DATE_PATTERNS = [
    # Full dates
    (r'\d{4}-\d{2}-\d{2}', 'iso_date'),  # 2024-03-15
    (r'\d{1,2}/\d{1,2}/\d{4}', 'us_date'),  # 03/15/2024
    (r'\d{1,2}/\d{1,2}/\d{2,4}', 'short_date'),  # 3/15/24
    (r'\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}', 'word_date'),  # 15 March 2024
    (r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}', 'word_date2'),  # March 15, 2024
    
    # Relative dates
    (r'yesterday', 'relative'),
    (r'today', 'relative'),
    (r'tomorrow', 'relative'),
    (r'this\s+(?:week|month|year)', 'relative'),
    (r'(?:last|next)\s+(?:week|month|year)', 'relative'),
    (r'\d+\s+(?:days?|weeks?|months?|years?)\s+(?:ago|earlier)', 'relative_past'),
    (r'in\s+(?:the\s+)?(?:next|coming)\s+(?:days?|weeks?|months?|years?)', 'relative_future'),
    
    # Time patterns
    (r'\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|AM|PM))?', 'time'),
    
    # Duration patterns
    (r'for\s+(?:the\s+)?(?:past\s+)?(\d+)\s+(?:days?|weeks?|months?|years?)', 'duration_past'),
    (r'(?:last|past)\s+(\d+)\s+(?:days?|weeks?|months?|years?)', 'duration_past'),
    
    # Event temporal markers
    (r'since\s+\d{4}', 'since'),
    (r'from\s+\d{4}', 'since'),
    (r'until\s+\d{4}', 'until'),
    (r'by\s+\d{4}', 'until'),
]

# Temporal classification keywords
TEMPORAL_KEYWORDS = {
    'PAST': [
        'yesterday', 'last week', 'last month', 'last year',
        'ago', 'earlier', 'previously', 'formerly', 'previously',
        'announced', 'occurred', 'happened', 'took place',
        'was', 'were', 'had', 'did',
        'struck', 'hit', 'killed', 'injured', 'died',
        'approved', 'rejected', 'confirmed', 'signed',
        'launched', 'opened', 'started', 'began',
        ' rose ', ' fell ', ' increased ', ' decreased ',
    ],
    'PRESENT': [
        'now', 'currently', 'at present', 'right now', 'today',
        'is happening', 'is occurring', 'is taking place',
        'is', 'are', 'says', 'said',
    ],
    'FUTURE': [
        'will', 'will be', 'shall', 'going to', 'plan to',
        'intends', 'expected', 'scheduled', 'tomorrow',
        'next week', 'next month', 'next year',
        'will announce', 'will build', 'will invest',
        'will create', 'will open', 'will start',
        'to build', 'to invest', 'to create', 'to open',
        'launch', 'launching', 'planned', 'planning',
    ],
    'ONGOING': [
        'ongoing', 'continues', 'continuing', 'still',
        'still ongoing', 'remains', 'remaining',
        'in progress', 'under way', 'underway',
        'has been', 'has been ongoing',
    ],
    'RECURRING': [
        'annual', 'yearly', 'monthly', 'every year',
        'annual meeting', 'annual conference',
        'election', 'elections', 'season',
        'festival', 'holiday',
    ],
}

# Certainty/Modal verbs
CERTAINTY_MODIFIERS = {
    # High certainty
    'confirmed': 0.9,
    'definitely': 0.95,
    'certainly': 0.9,
    'surely': 0.85,
    'clearly': 0.8,
    'obviously': 0.8,
    'officially': 0.85,
    
    # Medium certainty
    'reported': 0.75,
    'stated': 0.75,
    'announced': 0.75,
    'according to': 0.7,
    'sources say': 0.65,
    'sources said': 0.65,
    'officials say': 0.7,
    'officials said': 0.7,
    
    # Lower certainty
    'likely': 0.65,
    'probably': 0.65,
    'possibly': 0.45,
    'maybe': 0.4,
    'perhaps': 0.4,
    'might': 0.35,
    'could': 0.3,
    'may': 0.3,
    
    # Very low certainty
    'allegedly': 0.25,
    'rumored': 0.2,
    'supposedly': 0.2,
    'unconfirmed': 0.2,
    
    # Future/plan indicators
    'will': 0.8,
    'going to': 0.75,
    'plans to': 0.7,
    'expected to': 0.7,
    'to build': 0.6,
    'to invest': 0.6,
}


@dataclass
class TemporalFeature:
    has_absolute_date: bool = False
    has_relative_date: bool = False
    has_time: bool = False
    has_duration: bool = False
    temporal_classification: str = 'UNKNOWN'
    event_time: Optional[str] = None
    publication_time: Optional[str] = None
    time_since_event_hours: Optional[float] = None
    duration_mentioned: Optional[str] = None
    recurrence: Optional[str] = None
    certainty_score: float = 0.5
    modal_verbs: list = None
    temporal_markers: list = None
    
    def __post_init__(self):
        if self.modal_verbs is None:
            self.modal_verbs = []
        if self.temporal_markers is None:
            self.temporal_markers = []
    
    def to_dict(self) -> dict:
        return {
            'has_absolute_date': self.has_absolute_date,
            'has_relative_date': self.has_relative_date,
            'has_time': self.has_time,
            'has_duration': self.has_duration,
            'temporal_classification': self.temporal_classification,
            'event_time': self.event_time,
            'publication_time': self.publication_time,
            'time_since_event_hours': self.time_since_event_hours,
            'duration_mentioned': self.duration_mentioned,
            'recurrence': self.recurrence,
            'certainty_score': self.certainty_score,
            'modal_verbs': self.modal_verbs,
            'temporal_markers': self.temporal_markers,
        }


def extract_dates(text: str) -> dict:
    """Extract all date/time references from text."""
    dates = {
        'absolute': [],
        'relative': [],
        'times': [],
        'durations': [],
    }
    
    for pattern, dtype in DATE_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            value = match.group(0)
            
            if dtype == 'iso_date':
                dates['absolute'].append(value)
            elif dtype in ('us_date', 'short_date', 'word_date', 'word_date2'):
                dates['absolute'].append(value)
            elif dtype in ('time',):
                dates['times'].append(value)
            elif dtype in ('duration_past', 'duration_future'):
                dates['durations'].append(value)
            elif 'relative' in dtype or dtype in ('relative',):
                dates['relative'].append(value)
    
    return dates


def classify_temporal(text: str) -> str:
    """Classify the temporal context of the article."""
    text_lower = text.lower()
    
    scores = {k: 0 for k in TEMPORAL_KEYWORDS}
    
    for tclass, keywords in TEMPORAL_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in text_lower:
                scores[tclass] += 1
    
    # Check for recurrence
    if any(kw in text_lower for kw in TEMPORAL_KEYWORDS['RECURRING']):
        return 'RECURRING'
    
    # Find highest scoring classification
    max_score = max(scores.values())
    if max_score == 0:
        return 'UNKNOWN'
    
    # Get all classes with max score
    max_classes = [k for k, v in scores.items() if v == max_score]
    
    # Priority: ONGOING > PRESENT > PAST > FUTURE > UNKNOWN
    priority = ['ONGOING', 'PRESENT', 'PAST', 'FUTURE']
    for p in priority:
        if p in max_classes:
            return p
    
    return max_classes[0] if max_classes else 'UNKNOWN'


def extract_modal_verbs(text: str) -> list:
    """Extract modal/uncertainty verbs from text."""
    modal_verbs = []
    text_lower = text.lower()
    
    # Check for phrase patterns first (longer phrases)
    phrases = [
        'according to', 'sources say', 'sources said',
        'officials say', 'officials said',
        'going to', 'plans to', 'expected to',
    ]
    for phrase in phrases:
        if phrase in text_lower:
            modal_verbs.append({'verb': phrase, 'certainty_impact': CERTAINTY_MODIFIERS.get(phrase, 0.5)})
    
    # Use word boundaries for single words
    for verb, score in CERTAINTY_MODIFIERS.items():
        if ' ' in verb:  # Skip phrases (already handled)
            continue
        pattern = r'\b' + re.escape(verb) + r'\b'
        if re.search(pattern, text_lower, re.IGNORECASE):
            # Avoid duplicates
            if not any(m['verb'] == verb for m in modal_verbs):
                modal_verbs.append({'verb': verb, 'certainty_impact': score})
    
    return modal_verbs


def extract_temporal_features(text: str, published_at: datetime = None) -> dict:
    """Extract all temporal features from article text."""
    # Extract dates
    dates = extract_dates(text)
    
    # Classify temporal context
    classification = classify_temporal(text)
    
    # Extract modal verbs
    modal_verbs = extract_modal_verbs(text)
    
    # Calculate certainty score
    certainty_score = 0.5
    if modal_verbs:
        avg_impact = sum(m['certainty_impact'] for m in modal_verbs) / len(modal_verbs)
        certainty_score = avg_impact
    
    # Extract temporal markers
    temporal_markers = []
    text_lower = text.lower()
    for tclass, keywords in TEMPORAL_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in text_lower:
                temporal_markers.append({'marker': kw, 'class': tclass})
    
    # Determine event time (simplified - would need NER for proper extraction)
    event_time = None
    if dates['absolute']:
        event_time = dates['absolute'][0]
    
    # Calculate time since event (simplified)
    time_since_event = None
    if published_at and dates['absolute']:
        # Would need proper date parsing here
        pass
    
    # Duration mentioned
    duration = None
    if dates['durations']:
        duration = dates['durations'][0]
    
    # Recurrence
    recurrence = None
    if classification == 'RECURRING':
        recurrence = 'annual'  # Would need more specific detection
    
    feature = TemporalFeature(
        has_absolute_date=len(dates['absolute']) > 0,
        has_relative_date=len(dates['relative']) > 0,
        has_time=len(dates['times']) > 0,
        has_duration=len(dates['durations']) > 0,
        temporal_classification=classification,
        event_time=event_time,
        publication_time=published_at.isoformat() if published_at else None,
        time_since_event_hours=time_since_event,
        duration_mentioned=duration,
        recurrence=recurrence,
        certainty_score=round(certainty_score, 2),
        modal_verbs=modal_verbs[:10],  # Limit to top 10
        temporal_markers=temporal_markers[:20],  # Limit to top 20
    )
    
    return feature.to_dict()


def process_batch(limit: int = 1000, dry_run: bool = False) -> dict:
    """Process a batch of articles."""
    with connect() as conn:
        rows = conn.execute("""
            SELECT a.id, a.title, a.summary, a.body, a.published_at
            FROM news_articles a
            WHERE a.status = 'extracted'
            AND a.id NOT IN (
                SELECT article_id 
                FROM article_facts 
                WHERE temporal_features IS NOT NULL
            )
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,)).fetchall()
    
    processed = 0
    for row in rows:
        try:
            text = f"{row['title'] or ''} {row['summary'] or ''} {row['body'] or ''[:2000]}"
            features = extract_temporal_features(text, row['published_at'])
            
            if not dry_run:
                with connect() as conn:
                    conn.execute("""
                        INSERT INTO article_facts (article_id, temporal_features)
                        VALUES (%s, %s)
                        ON CONFLICT (article_id) DO UPDATE SET
                            temporal_features = EXCLUDED.temporal_features
                    """, (row['id'], features))
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['id'], e)
    
    return {'processed': processed, 'total': len(rows)}


def main():
    parser = argparse.ArgumentParser(description="Extract temporal features from articles")
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
