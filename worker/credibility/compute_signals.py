#!/usr/bin/env python3
"""
Background worker to compute credibility signals for articles.
Runs in batches to avoid overloading the database.

Usage:
    python3 -m worker.credibility.compute_signals --batch-size 100 --max-articles 10000
"""

import argparse
import json
import re
import sys
import os
from datetime import datetime
from typing import Dict, List, Any, Optional, Set

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2

EMOTIONAL_WORDS: Set[str] = {
    'shocking', 'devastating', 'catastrophic', 'unbelievable', 'outrageous',
    'miracle', 'disaster', 'tragedy', 'explosive', 'breaking', 'urgent',
    'scandal', 'exposed', 'secret', 'conspiracy', 'lie', 'fake', 'hoax',
    'sensational', 'dramatic', 'crisis', 'emergency'
}

CITED_DOMAIN_CREDIBILITY: Dict[str, float] = {
    'gov': 1.0, 'edu': 1.0, 'org': 0.8,
    'reuters': 1.0, 'apnews': 1.0, 'afp': 0.95,
    'bbc': 0.95, 'nyt': 0.9, 'wsj': 0.9, 'wapo': 0.9,
    'theguardian': 0.85, 'cnn': 0.8, 'nbc': 0.8, 'abc': 0.8, 'cbs': 0.8,
    'npr': 0.9, 'pbs': 0.9, 'bloomberg': 0.85, 'ft': 0.85, 'economist': 0.9,
    'snopes': 0.95, 'politifact': 0.95, 'factcheck': 0.95,
    'wikipedia': 0.4, 'facebook': 0.1, 'twitter': 0.1, 'reddit': 0.15,
    'youtube': 0.15, 'tiktok': 0.1, 'instagram': 0.1
}

FACTUAL_PATTERNS = [
    (r'\d{4}-\d{2}-\d{2}', 'date'),
    (r'\d{1,2}/\d{1,2}/\d{2,4}', 'date'),
    (r'\d+(?:\.\d+)?%', 'percentage'),
    (r'\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\s+(?:million|billion|trillion)?', 'number'),
    (r'\b(?:governor|senator|president|ceo|director|dr\.|prof\.)\s+[A-Z]', 'title_name'),
    (r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+', 'proper_name'),
]


def extract_citations(text: str) -> tuple:
    url_pattern = re.compile(r'https?://[^\s]+', re.IGNORECASE)
    urls = url_pattern.findall(text)
    domains = []
    for url in urls[:20]:
        domain_match = re.search(r'(?:https?://)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})', url, re.IGNORECASE)
        if domain_match:
            domains.append(domain_match.group(1).lower())
    return list(set(domains))


def get_citation_credibility(domain: str) -> float:
    d = domain.lower()
    for known, score in CITED_DOMAIN_CREDIBILITY.items():
        if known in d:
            return score
    return 0.3


def calculate_emotional_ratio(text: str) -> float:
    words = text.lower().split()
    if not words:
        return 0.0
    emotional_count = sum(1 for w in words if w in EMOTIONAL_WORDS)
    return min(1.0, (emotional_count / len(words)) * 10)


def calculate_sensationalism(title: str, body: str) -> float:
    score = 0.0
    if re.search(r'\b[A-Z]{5,}\b', title):
        score += 0.3
    if re.search(r'!{2,}', title):
        score += 0.2
    if re.search(r'\b(you won\'t believe|shocking|explosive|breaking|urgent|just in)\b', title, re.I):
        score += 0.3
    if re.search(r'\b[A-Z]{5,}\b', body):
        score += 0.1
    return min(1.0, score)


def calculate_factual_density(text: str) -> float:
    fact_count = 0
    for pattern, _ in FACTUAL_PATTERNS:
        fact_count += len(re.findall(pattern, text))
    word_count = len(text.split())
    return min(1.0, (fact_count / max(1, word_count)) * 10)


def compute_article_factors(article: Dict[str, Any]) -> List[Dict[str, Any]]:
    factors = []

    title = article.get('title') or ''
    body = article.get('body') or ''
    full_text = f"{title} {body}"

    source_reliability = article.get('source_reliability_score') or 0.5
    factors.append({
        'factor': 'source_historical_accuracy',
        'label': 'Source Reliability Score',
        'value': f"{int(source_reliability * 100)}%",
        'description': 'Source has strong reliability rating' if source_reliability > 0.7 else 'Source has moderate reliability' if source_reliability > 0.4 else 'Source has limited reliability data',
        'weight': 'high',
        'verdict': 'positive' if source_reliability > 0.7 else 'neutral' if source_reliability > 0.4 else 'concern'
    })

    citations = extract_citations(body)
    if citations:
        citation_quality = sum(get_citation_credibility(c) for c in citations) / len(citations)
        factors.append({
            'factor': 'source_citations',
            'label': 'Sources Cited',
            'value': f"{len(citations)} sources",
            'description': f"Cites external sources with {int(citation_quality * 100)}% average credibility",
            'weight': 'high',
            'verdict': 'positive' if citation_quality > 0.6 else 'neutral' if citation_quality > 0.3 else 'concern'
        })
    else:
        factors.append({
            'factor': 'no_citations',
            'label': 'No External Sources',
            'value': 'No citations found',
            'description': 'Article does not cite external sources - claims cannot be easily verified',
            'weight': 'high',
            'verdict': 'concern'
        })

    factual_density = calculate_factual_density(full_text)
    factors.append({
        'factor': 'factual_density',
        'label': 'Factual Specificity',
        'value': f"{int(factual_density * 100)}%",
        'description': 'Ratio of specific facts (numbers, dates, names) to general claims',
        'weight': 'medium',
        'verdict': 'positive' if factual_density > 0.15 else 'neutral' if factual_density > 0.05 else 'concern'
    })

    emotional_ratio = calculate_emotional_ratio(full_text)
    if emotional_ratio > 0.03:
        factors.append({
            'factor': 'emotional_language',
            'label': 'Emotional Language',
            'value': f"{int(emotional_ratio * 100)}%",
            'description': 'High emotional language may indicate opinion over fact',
            'weight': 'medium',
            'verdict': 'concern' if emotional_ratio > 0.08 else 'neutral'
        })

    sensationalism = calculate_sensationalism(title, body)
    if sensationalism > 0.2:
        factors.append({
            'factor': 'sensationalism',
            'label': 'Sensationalist Style',
            'value': f"{int(sensationalism * 100)}%",
            'description': 'Uses ALL CAPS, excessive punctuation, or clickbait phrases',
            'weight': 'medium',
            'verdict': 'concern'
        })

    word_count = len(body.split())
    factors.append({
        'factor': 'article_depth',
        'label': 'Article Depth',
        'value': 'Brief' if word_count < 300 else 'Standard' if word_count < 800 else 'Detailed' if word_count < 1500 else 'In-Depth',
        'description': f"{word_count} words - {'may lack detail' if word_count < 300 else 'comprehensive coverage' if word_count > 800 else 'standard length'}",
        'weight': 'low',
        'verdict': 'positive' if word_count > 300 else 'neutral'
    })

    has_author = bool(re.search(r'by\s+[A-Z][a-z]+', body[:500], re.I))
    has_dateline = bool(re.search(r'\b(Reuters|AP|AFP|Bloomberg)\b', body[:500]))
    if has_author or has_dateline:
        factors.append({
            'factor': 'attribution',
            'label': 'Proper Attribution',
            'value': ' + '.join(filter(None, ['Author' if has_author else None, 'Dateline' if has_dateline else None])),
            'description': 'Article has named author and/or publication dateline',
            'weight': 'low',
            'verdict': 'positive'
        })

    factors.sort(key=lambda f: {'high': 0, 'medium': 1, 'low': 2}.get(f['weight'], 3))

    return factors


def process_articles(batch_size: int = 100, max_articles: int = 100000, offset: int = 0) -> Dict[str, Any]:
    dsn = os.environ.get('XYZO_DB_DSN', 'postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo')

    conn = psycopg2.connect(dsn)
    cur = conn.cursor()

    total_processed = 0
    total_updated = 0

    while True:
        if total_processed >= max_articles:
            break

        cur.execute("""
            SELECT
                a.id, a.title, a.body, a.url, a.source_id,
                s.reliability_score as source_reliability_score,
                s.error_count as source_error_count,
                s.created_at as source_created_at,
                s.name as source_name
            FROM news_articles a
            LEFT JOIN news_sources s ON a.source_id = s.id
            WHERE a.credibility_signals IS NULL
            ORDER BY a.id
            LIMIT %s
        """, (batch_size,))

        rows = cur.fetchall()
        if not rows:
            break

        for row in rows:
            article_id, title, body, url, source_id = row[0], row[1], row[2], row[3], row[4]
            source_reliability_score = row[5]
            source_error_count = row[6]
            source_created_at = row[7]
            source_name = row[8]

            article = {
                'id': article_id,
                'title': title,
                'body': body,
                'url': url,
                'source_id': source_id,
                'source_reliability_score': source_reliability_score,
                'source_error_count': source_error_count,
                'source_created_at': source_created_at,
                'source_name': source_name
            }

            factors = compute_article_factors(article)

            signals = json.dumps({
                'factors': factors,
                'note': 'Observable credibility factors only. Not a truth claim.',
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            })

            cur.execute("""
                UPDATE news_articles
                SET credibility_signals = %s
                WHERE id = %s
            """, (signals, article_id))

            total_updated += 1

        conn.commit()
        total_processed += len(rows)
        offset += len(rows)

        print(f"Processed {total_processed} articles, updated {total_updated}...")

    cur.close()
    conn.close()

    return {
        'total_processed': total_processed,
        'total_updated': total_updated
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Compute credibility signals for articles')
    parser.add_argument('--batch-size', type=int, default=100, help='Batch size for processing')
    parser.add_argument('--max-articles', type=int, default=100000, help='Maximum articles to process')
    parser.add_argument('--offset', type=int, default=0, help='Starting offset')
    args = parser.parse_args()

    print(f"Starting credibility computation (batch={args.batch_size}, max={args.max_articles})...")

    result = process_articles(
        batch_size=args.batch_size,
        max_articles=args.max_articles,
        offset=args.offset
    )

    print(f"\nDone! Processed {result['total_processed']} articles, updated {result['total_updated']}")
