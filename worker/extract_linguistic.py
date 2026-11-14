#!/usr/bin/env python3
"""Extract linguistic features from article text.

This captures the "linguistic DNA" of an article:
- word_count, unique_word_count
- type/token ratio
- lexical entropy
- sentence statistics
- n-gram patterns
- technical vocabulary
- etc.

Usage:
    python -m worker.extract_linguistic                    # full extraction
    python -m worker.extract_linguistic --limit 1000     # limit
"""

import argparse
import logging
import math
import re
from collections import Counter
from typing import Optional

from .db import connect

log = logging.getLogger("xyzo.extract_linguistic")

# Technical/domain vocabulary patterns
TECHNICAL_PATTERNS = [
    (r'\b(?:AI|artificial intelligence| machine learning|deep learning|LLM|GPT|neural network)\b', 'technology'),
    (r'\b(?:climate|global warming|carbon emissions|greenhouse|renewable)\b', 'climate'),
    (r'\b(?:pandemic|virus|vaccine|outbreak|COVID|health)\b', 'health'),
    (r'\b(?:election|vote|parliament|congress|senate|democracy)\b', 'politics'),
    (r'\b(?:stock|market|GDP|inflation|recession|economy)\b', 'finance'),
    (r'\b(?:treaty|ceasefire|invasion|military|troops)\b', 'conflict'),
    (r'\b(?:research|study|scientist|laboratory|experiment)\b', 'science'),
]

# N-gram patterns
COMMON_BIGRAMS = [
    'climate change', 'global warming', 'interest rate',
    'stock market', 'artificial intelligence', 'machine learning',
    'deep learning', 'social media', 'supply chain', 'world war',
]

COMMON_TRIGRAMS = [
    'climate change', 'global warming', 'artificial intelligence',
    'supply chain', 'world war', 'interest rate hike',
]


def tokenize(text: str) -> list:
    """Simple tokenization."""
    text = text.lower()
    # Remove punctuation and split
    text = re.sub(r'[^\w\s]', ' ', text)
    tokens = text.split()
    return [t for t in tokens if len(t) > 1]  # Filter single chars


def compute_entropy(tokens: list) -> float:
    """Compute Shannon entropy of token distribution."""
    if not tokens:
        return 0.0
    
    freq = Counter(tokens)
    total = len(tokens)
    
    entropy = 0.0
    for count in freq.values():
        p = count / total
        if p > 0:
            entropy -= p * math.log2(p)
    
    return entropy


def extract_ngrams(tokens: list, n: int = 2) -> list:
    """Extract n-grams from tokens."""
    if len(tokens) < n:
        return []
    return [' '.join(tokens[i:i+n]) for i in range(len(tokens) - n + 1)]


def detect_technical_terms(text: str) -> dict:
    """Detect technical/domain vocabulary."""
    text_lower = text.lower()
    detected = {}
    
    for pattern, domain in TECHNICAL_PATTERNS:
        matches = re.findall(pattern, text_lower)
        if matches:
            detected[domain] = len(matches)
    
    return detected


def extract_linguistic_features(text: str) -> dict:
    """Extract comprehensive linguistic features."""
    # Tokenize
    tokens = tokenize(text)
    word_count = len(tokens)
    unique_words = len(set(tokens))
    
    # Basic ratios
    type_token_ratio = unique_words / word_count if word_count > 0 else 0
    
    # Entropy
    lexical_entropy = compute_entropy(tokens)
    
    # Sentence analysis
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    sentence_count = len(sentences)
    avg_sentence_length = word_count / sentence_count if sentence_count > 0 else 0
    
    # Word length distribution
    word_lengths = [len(t) for t in tokens]
    avg_word_length = sum(word_lengths) / len(word_lengths) if word_lengths else 0
    
    # Character count
    char_count = len(text)
    char_no_space = len(text.replace(' ', ''))
    
    # Punctuation density
    punct_count = len(re.findall(r'[^\w\s]', text))
    punct_density = punct_count / char_count if char_count > 0 else 0
    
    # Number density
    number_matches = re.findall(r'\d+', text)
    number_count = len(number_matches)
    number_density = number_count / word_count if word_count > 0 else 0
    
    # Capitalization
    capitalized = len(re.findall(r'\b[A-Z][a-z]+\b', text))
    capitalized_ratio = capitalized / word_count if word_count > 0 else 0
    
    # Uppercase words (ALL CAPS)
    uppercase_words = len(re.findall(r'\b[A-Z]{2,}\b', text))
    
    # N-grams
    bigrams = extract_ngrams(tokens, 2)
    trigrams = extract_ngrams(tokens, 3)
    
    # Count common bigrams/trigrams
    common_bigram_count = sum(1 for bg in bigrams if bg in COMMON_BIGRAMS)
    common_trigram_count = sum(1 for tg in trigrams if tg in COMMON_TRIGRAMS)
    
    # Technical vocabulary detection
    technical_terms = detect_technical_terms(text)
    technical_ratio = sum(technical_terms.values()) / word_count if word_count > 0 else 0
    
    # Quote detection
    quote_count = len(re.findall(r'"[^"]+"', text))
    quote_ratio = quote_count / sentence_count if sentence_count > 0 else 0
    
    # Question detection
    question_count = len(re.findall(r'\?', text))
    
    # Exclamation detection
    exclamation_count = len(re.findall(r'!', text))
    
    return {
        # Basic counts
        'word_count': word_count,
        'unique_word_count': unique_words,
        'sentence_count': sentence_count,
        'char_count': char_count,
        
        # Ratios
        'type_token_ratio': round(type_token_ratio, 4),
        'lexical_entropy': round(lexical_entropy, 4),
        'punct_density': round(punct_density, 4),
        'number_density': round(number_density, 4),
        'capitalized_ratio': round(capitalized_ratio, 4),
        'technical_ratio': round(technical_ratio, 4),
        'quote_ratio': round(quote_ratio, 4),
        
        # Averages
        'avg_sentence_length': round(avg_sentence_length, 2),
        'avg_word_length': round(avg_word_length, 2),
        
        # Structural
        'uppercase_word_count': uppercase_words,
        'number_count': number_count,
        'quote_count': quote_count,
        'question_count': question_count,
        'exclamation_count': exclamation_count,
        
        # N-gram stats
        'bigram_count': len(bigrams),
        'trigram_count': len(trigrams),
        'common_bigram_count': common_bigram_count,
        'common_trigram_count': common_trigram_count,
        
        # Technical domains
        'technical_domains': technical_terms,
        
        # Top words (most frequent)
        'top_words': dict(Counter(tokens).most_common(20)),
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
                WHERE linguistic_features IS NOT NULL
            )
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,)).fetchall()
    
    processed = 0
    for row in rows:
        try:
            text = f"{row['title'] or ''} {row['summary'] or ''} {row['body'] or ''[:3000]}"
            features = extract_linguistic_features(text)
            
            if not dry_run:
                with connect() as conn:
                    conn.execute("""
                        INSERT INTO article_facts (article_id, linguistic_features)
                        VALUES (%s, %s)
                        ON CONFLICT (article_id) DO UPDATE SET
                            linguistic_features = EXCLUDED.linguistic_features
                    """, (row['id'], features))
            
            processed += 1
            
        except Exception as e:
            log.error("Error processing article %d: %s", row['id'], e)
    
    return {'processed': processed, 'total': len(rows)}


def main():
    parser = argparse.ArgumentParser(description="Extract linguistic features from articles")
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
