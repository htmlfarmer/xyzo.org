"""problem_detector.py — identifies recurring/emerging problem patterns from events.

Safe to run: reads only, creates new records, never deletes or modifies existing data.

Usage:
    python -m worker.problem_detector                    # normal run
    python -m worker.problem_detector --dry-run          # show what would happen
    python -m worker.problem_detector --window 7         # use 7-day window
    python -m worker.problem_detector --min-occurrences 5 # require 5+ events
    python -m worker.problem_detector --limit 20         # process top 20 problems
"""
from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.problem_detector")

DEFAULT_WINDOW_DAYS = 30
DEFAULT_MIN_OCCURRENCES = 3
DEFAULT_LIMIT = 50


@dataclass
class ProblemPattern:
    location_id: int
    location_name: str
    country_code: str
    event_type: str
    occurrence_count: int
    first_detected: datetime
    last_occurrence: datetime
    avg_confidence: float
    recent_acceleration: float  # >1 means speeding up
    headlines: list[str]

    @property
    def problem_key(self) -> str:
        return f"prob_{self.location_id}_{self.event_type}"

    def severity_score(self, window_days: int) -> float:
        recency_decay = max(0.0, 1.0 - (datetime.now(timezone.utc) - self.last_occurrence).total_seconds() / (window_days * 86400))
        freq_score = min(1.0, self.occurrence_count / 10)
        return min(1.0, (freq_score * 0.6 + recency_decay * 0.4))

    def urgency_score(self) -> float:
        if self.recent_acceleration >= 2.0:
            return 1.0
        if self.recent_acceleration >= 1.5:
            return 0.8
        if self.recent_acceleration >= 1.2:
            return 0.6
        if self.recent_acceleration >= 1.0:
            return 0.4
        return 0.2 + (self.recent_acceleration * 0.2)

    def problem_type(self) -> str:
        if self.recent_acceleration >= 1.8:
            return "worsening"
        if self.occurrence_count >= 5:
            return "recurring"
        return "emerging"

    def headline(self) -> str:
        type_labels = {
            "disaster": "repeated disasters",
            "conflict": "ongoing conflict",
            "health": "health concerns",
            "weather": "severe weather",
            "crime": "crime wave",
            "economic": "economic distress",
            "politics": "political instability",
        }
        label = type_labels.get(self.event_type, f"repeated {self.event_type} events")
        return f"{self.location_name}: {label}"


def find_problem_patterns(
    window_days: int = DEFAULT_WINDOW_DAYS,
    min_occurrences: int = DEFAULT_MIN_OCCURRENCES,
    limit: int = DEFAULT_LIMIT,
) -> list[ProblemPattern]:
    """Find recurring event patterns that suggest a problem."""

    half_window = window_days // 2

    with connect() as conn, conn.cursor() as cur:
        # Group events by (location, event_type) and find patterns
        cur.execute("""
            SELECT
                l.id AS location_id,
                l.place_name AS location_name,
                l.country AS country_code,
                e.event_type,
                COUNT(*) AS occurrence_count,
                MIN(e.first_reported_at) AS first_detected,
                MAX(e.first_reported_at) AS last_occurrence,
                AVG(e.avg_confidence) AS avg_confidence,
                ARRAY_AGG(DISTINCT LEFT(e.headline, 120)) AS headlines
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.status = 'active'
              AND e.first_reported_at > NOW() - INTERVAL '%s days'
            GROUP BY l.id, l.place_name, l.country, e.event_type
            HAVING COUNT(*) >= %s
            ORDER BY COUNT(*) DESC
            LIMIT %s
        """, (window_days, min_occurrences, limit))

        patterns = []
        for row in cur.fetchall():
            # Calculate recent acceleration: events in second half vs first half
            recent_count = _count_events_in_window(
                conn, row['location_id'], row['event_type'], half_window
            )
            older_count = _count_events_in_window(
                conn, row['location_id'], row['event_type'], window_days, offset_days=half_window
            )

            acceleration = recent_count / max(1, older_count)

            patterns.append(ProblemPattern(
                location_id=row['location_id'],
                location_name=row['location_name'] or 'Unknown',
                country_code=row['country_code'] or 'XX',
                event_type=row['event_type'] or 'other',
                occurrence_count=row['occurrence_count'],
                first_detected=row['first_detected'],
                last_occurrence=row['last_occurrence'],
                avg_confidence=float(row['avg_confidence'] or 0.5),
                recent_acceleration=float(acceleration),
                headlines=[h for h in (row['headlines'] or []) if h][:5],
            ))

        return patterns


def _count_events_in_window(
    conn,
    location_id: int,
    event_type: str,
    window_days: int,
    offset_days: int = 0,
) -> int:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*)
            FROM news_events e
            WHERE e.primary_location_id = %s
              AND e.event_type = %s
              AND e.status = 'active'
              AND e.first_reported_at > NOW() - INTERVAL '%s days' - INTERVAL '%s days'
              AND e.first_reported_at <= NOW() - INTERVAL '%s days'
        """, (location_id, event_type, offset_days + window_days, offset_days, offset_days))
        return int(cur.fetchone()["count"])


def upsert_problem(pattern: ProblemPattern, window_days: int) -> int:
    """Create or update a problem record. Returns problem_id."""

    severity = pattern.severity_score(window_days)
    urgency = pattern.urgency_score()
    problem_type = pattern.problem_type()

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_problems (
                problem_key, event_type, headline, description,
                location_id, country_code, problem_type,
                severity, urgency, occurrence_count,
                first_detected, last_occurrence, window_days,
                confidence, updated_at
            )
            VALUES (
                %(key)s, %(type)s, %(headline)s, %(desc)s,
                %(loc_id)s, %(country)s, %(prob_type)s,
                %(severity)s, %(urgency)s, %(count)s,
                %(first)s, %(last)s, %(window)s,
                %(confidence)s, NOW()
            )
            ON CONFLICT (problem_key) DO UPDATE SET
                headline      = EXCLUDED.headline,
                description    = EXCLUDED.description,
                severity       = EXCLUDED.severity,
                urgency        = EXCLUDED.urgency,
                occurrence_count = EXCLUDED.occurrence_count,
                last_occurrence = EXCLUDED.last_occurrence,
                problem_type   = EXCLUDED.problem_type,
                confidence     = EXCLUDED.confidence,
                updated_at     = NOW()
            RETURNING id
        """, {
            'key': pattern.problem_key,
            'type': pattern.event_type,
            'headline': pattern.headline(),
            'desc': ' | '.join(pattern.headlines[:3]),
            'loc_id': pattern.location_id,
            'country': pattern.country_code,
            'prob_type': problem_type,
            'severity': severity,
            'urgency': urgency,
            'count': pattern.occurrence_count,
            'first': pattern.first_detected,
            'last': pattern.last_occurrence,
            'window': window_days,
            'confidence': pattern.avg_confidence,
        })
        problem_id = cur.fetchone()["id"]
        conn.commit()
        return int(problem_id)


def link_events_to_problem(problem_id: int, location_id: int, event_type: str, window_days: int) -> int:
    """Link recent events to the problem record."""

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_problem_events (problem_id, event_id)
            SELECT %s, e.id
            FROM news_events e
            WHERE e.primary_location_id = %s
              AND e.event_type = %s
              AND e.status = 'active'
              AND e.first_reported_at > NOW() - INTERVAL '%s days'
            ON CONFLICT DO NOTHING
        """, (problem_id, location_id, event_type, window_days))

        linked = cur.rowcount
        conn.commit()
        return linked


def generate_default_actions(problem_id: int, pattern: ProblemPattern) -> int:
    """Generate default action recommendations for a problem."""

    templates = _action_templates_for_event_type(pattern.event_type)

    with connect() as conn, conn.cursor() as cur:
        actions_created = 0
        for template in templates:
            cur.execute("""
                INSERT INTO news_problem_actions (
                    problem_id, action_key, headline, description,
                    who_can_do, expected_benefit, risks,
                    confidence, time_horizon, requires_human_approval, status
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE, 'pending')
                ON CONFLICT DO NOTHING
            """, (
                problem_id,
                template['key'],
                template['headline'].format(location=pattern.location_name),
                template['description'],
                template['who'],
                template.get('benefit', 'Unknown'),
                template.get('risks', ''),
                template.get('confidence', 0.5),
                template.get('time', 'short_term'),
            ))
            actions_created += 1

        conn.commit()
        return actions_created


def _action_templates_for_event_type(event_type: str) -> list[dict]:
    """Return action templates based on event type."""

    templates = {
        'disaster': [
            {
                'key': 'INFORMATION',
                'headline': 'Share verified emergency information in {location}',
                'description': 'Help spread official emergency contacts, evacuation routes, and shelter locations.',
                'who': ['ordinary_person'],
                'benefit': 'Faster emergency response',
                'risks': 'Spread only official sources — avoid rumors',
                'confidence': 0.7,
                'time': 'immediate',
            },
            {
                'key': 'FINANCIAL',
                'headline': 'Donate to established relief organizations working in {location}',
                'description': 'Contribute to recognized NGOs with on-the-ground capacity. Verify registration before donating.',
                'who': ['ordinary_person'],
                'benefit': 'Direct relief support',
                'risks': 'Scam risk — verify organization credentials',
                'confidence': 0.6,
                'time': 'immediate',
            },
            {
                'key': 'PREPARATION',
                'headline': 'Review family emergency plan',
                'description': 'Ensure your household has a communication plan, basic supplies, and knows evacuation routes.',
                'who': ['ordinary_person'],
                'benefit': 'Reduce future impact',
                'risks': 'None',
                'confidence': 0.8,
                'time': 'short_term',
            },
        ],
        'health': [
            {
                'key': 'INFORMATION',
                'headline': 'Share public health guidance for {location}',
                'description': 'Help distribute accurate health information from official sources (WHO, CDC, local health dept).',
                'who': ['ordinary_person'],
                'benefit': 'Better public awareness',
                'risks': 'Share only verified sources',
                'confidence': 0.7,
                'time': 'immediate',
            },
            {
                'key': 'LEARN',
                'headline': 'Learn symptoms and prevention measures',
                'description': 'Understand the condition to protect yourself and family. Use official health guidance.',
                'who': ['ordinary_person'],
                'benefit': 'Personal protection',
                'risks': 'Self-diagnosis is not a substitute for medical care',
                'confidence': 0.7,
                'time': 'short_term',
            },
            {
                'key': 'PREPARATION',
                'headline': 'Ensure basic medical supplies and prescriptions',
                'description': 'Check you have necessary medications and basic first-aid supplies.',
                'who': ['ordinary_person'],
                'benefit': 'Readiness for health emergencies',
                'risks': 'Do not hoard supplies',
                'confidence': 0.6,
                'time': 'short_term',
            },
        ],
        'conflict': [
            {
                'key': 'INFORMATION',
                'headline': 'Follow credible news sources covering {location}',
                'description': 'Monitor the situation through verified international news sources.',
                'who': ['ordinary_person'],
                'benefit': 'Accurate information',
                'risks': 'Disinformation is common in conflicts',
                'confidence': 0.6,
                'time': 'immediate',
            },
            {
                'key': 'ADVOCACY',
                'headline': 'Contact elected representatives about {location}',
                'description': 'Urge diplomatic efforts and humanitarian access.',
                'who': ['ordinary_person', 'organization'],
                'benefit': 'Political pressure for peace',
                'risks': 'Be informed — avoid inflammatory language',
                'confidence': 0.4,
                'time': 'short_term',
            },
            {
                'key': 'HUMANITARIAN',
                'headline': 'Support humanitarian organizations in {location}',
                'description': 'Donate to or volunteer with established humanitarian NGOs.',
                'who': ['ordinary_person', 'organization'],
                'benefit': 'Direct aid to affected civilians',
                'risks': 'Verify organization legitimacy',
                'confidence': 0.6,
                'time': 'short_term',
            },
        ],
        'weather': [
            {
                'key': 'PREPARATION',
                'headline': 'Monitor weather alerts for {location}',
                'description': 'Track official meteorological service warnings.',
                'who': ['ordinary_person'],
                'benefit': 'Personal safety',
                'risks': 'Official warnings only — ignore sensational forecasts',
                'confidence': 0.8,
                'time': 'immediate',
            },
        ],
        'environment': [
            {
                'key': 'INFORMATION',
                'headline': 'Learn about environmental issues affecting {location}',
                'description': 'Understand the specific environmental challenges and their causes.',
                'who': ['ordinary_person'],
                'benefit': 'Informed citizenry',
                'risks': 'None',
                'confidence': 0.7,
                'time': 'short_term',
            },
            {
                'key': 'ADVOCACY',
                'headline': 'Support environmental protection policies',
                'description': 'Engage with local representatives about environmental regulations.',
                'who': ['ordinary_person', 'organization'],
                'benefit': 'Policy change',
                'risks': 'Engage constructively with evidence',
                'confidence': 0.5,
                'time': 'long_term',
            },
        ],
    }

    # Default fallback templates
    fallback = [
        {
            'key': 'INFORMATION',
            'headline': 'Learn more about the situation in {location}',
            'description': 'Follow the situation through reliable news sources.',
            'who': ['ordinary_person'],
            'benefit': 'Better understanding',
            'risks': 'None',
            'confidence': 0.6,
            'time': 'short_term',
        },
    ]

    return templates.get(event_type, fallback)


def run(
    window_days: int = DEFAULT_WINDOW_DAYS,
    min_occurrences: int = DEFAULT_MIN_OCCURRENCES,
    limit: int = DEFAULT_LIMIT,
    dry_run: bool = False,
) -> dict:
    """Main entry point. Returns a summary dict."""

    log.info("problem_detector: window=%d, min_occ=%d, limit=%d, dry_run=%s",
             window_days, min_occurrences, limit, dry_run)

    patterns = find_problem_patterns(window_days, min_occurrences, limit)
    log.info("found %d problem patterns", len(patterns))

    if dry_run:
        for p in patterns[:10]:
            severity = p.severity_score(window_days)
            urgency = p.urgency_score()
            log.info("  [DRY RUN] %s (%s) — severity=%.2f urgency=%.2f count=%d accel=%.1fx",
                     p.headline(), p.problem_type(), severity, urgency,
                     p.occurrence_count, p.recent_acceleration)
        return {
            "dry_run": True,
            "patterns_found": len(patterns),
            "would_create": len(patterns),
            "would_link_events": sum(p.occurrence_count for p in patterns),
        }

    problems_created = 0
    events_linked = 0
    actions_created = 0

    for pattern in patterns:
        problem_id = upsert_problem(pattern, window_days)
        problems_created += 1

        linked = link_events_to_problem(
            problem_id, pattern.location_id, pattern.event_type, window_days
        )
        events_linked += linked

        actions_created += generate_default_actions(problem_id, pattern)

    log.info("problem_detector: created=%d problems, linked=%d events, actions=%d",
             problems_created, events_linked, actions_created)

    return {
        "problems_created": problems_created,
        "events_linked": events_linked,
        "actions_created": actions_created,
        "patterns_found": len(patterns),
    }


if __name__ == "__main__":
    import sys
    import json

    parser = argparse.ArgumentParser(description="Problem detector for XYZO Action Engine")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would happen without writing anything")
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW_DAYS,
                        help=f"Days to look back (default {DEFAULT_WINDOW_DAYS})")
    parser.add_argument("--min-occurrences", type=int, default=DEFAULT_MIN_OCCURRENCES,
                        help=f"Min event occurrences (default {DEFAULT_MIN_OCCURRENCES})")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help=f"Max problems to process (default {DEFAULT_LIMIT})")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    result = run(
        window_days=args.window,
        min_occurrences=args.min_occurrences,
        limit=args.limit,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, default=str))
