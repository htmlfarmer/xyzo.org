"""
Credibility Signal Extractor
Extracts factors that indicate credibility - NOT a score, just observable signals.
Legal: These are informational signals only, not truth claims.
"""

import re
import math
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from html import escape

EMOTIONAL_WORDS = {
    'shocking', 'devastating', 'catastrophic', 'unbelievable', 'outrageous',
    'miracle', 'disaster', 'tragedy', 'explosive', 'breaking', 'urgent',
    'scandal', 'exposed', 'secret', 'conspiracy', 'lie', 'fake', 'hoax',
    'sensational', 'dramatic', 'crisis', 'emergency', 'disaster'
}

SENSATIONAL_PATTERNS = [
    r'\b[A-Z]{5,}\b',  # ALL CAPS words
    r'!{2,}',  # Multiple exclamation marks
    r'\?\?+',  # Multiple question marks
    r'\b(you won\'t believe|shocking|explosive|breaking|urgent|just in)\b',
    r'\[?(?:exclusive|leaked|confidential|internal)\]?',
]

FACTUAL_PATTERNS = [
    r'\b\d{4}-\d{2}-\d{2}\b',  # Dates
    r'\b\d{1,2}/\d{1,2}/\d{2,4}\b',  # Dates
    r'\b\d+(?:\.\d+)?%\b',  # Percentages
    r'\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s+(?:million|billion|trillion)?\b',  # Numbers
    r'\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b',  # Month dates
    r'\b(?:governor|senator|president|ceo|director|dr\.|prof\.)\s+[A-Z]',  # Titles + names
    r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b',  # Proper names
]

CITED_DOMAIN_CREDIBILITY = {
    'gov': 1.0, 'edu': 1.0, 'org': 0.8, 'reuters': 1.0, 'apnews': 1.0,
    'afp': 0.95, 'bbc': 0.95, 'nyt': 0.9, 'wsj': 0.9, 'wapo': 0.9,
    'theguardian': 0.85, 'cnn': 0.8, 'nbc': 0.8, 'abc': 0.8, 'cbs': 0.8,
    'npr': 0.9, 'pbs': 0.9, 'bloomberg': 0.85, 'ft': 0.85, 'economist': 0.9,
    'snopes': 0.95, 'politifact': 0.95, 'factcheck': 0.95, 'afpfactuel': 0.95,
    'wikipedia': 0.4, 'facebook': 0.1, 'twitter': 0.1, 'reddit': 0.15,
    'youtube': 0.15, 'tiktok': 0.1, 'instagram': 0.1
}

CITATION_PATTERN = re.compile(
    r'(?:https?://)?(?:www\.)?([a-z0-9-]+(?:\.[a-z]{2,})+)',
    re.IGNORECASE
)


@dataclass
class CredibilitySignals:
    """
    All signals are FACTORS that MAY indicate credibility.
    Legal: These are observations, not judgments. Users should evaluate.
    """
    # Source credibility signals
    source_historical_accuracy: float = 0.5
    source_error_rate: float = 0.0
    source_age_years: float = 0.0
    source_transparency_score: float = 0.5
    source_topic_expertise: float = 0.0
    source_has_corrections_policy: bool = False
    source_domain_credibility: float = 0.5

    # Content credibility signals
    citation_count: int = 0
    citation_quality_score: float = 0.0
    factual_density: float = 0.0
    emotional_language_ratio: float = 0.0
    sensationalism_score: float = 0.0
    specificity_score: float = 0.0
    claim_verifiability: float = 0.0
    word_count: int = 0
    has_dateline: bool = False
    has_author: bool = False
    has_photos: bool = False

    # Network signals
    cross_source_count: int = 0
    cross_source_credibility_avg: float = 0.0
    source_outlier_score: float = 0.0

    # Temporal signals
    publication_hour: int = 12
    is_business_hours: bool = True
    sources_recency_days: int = 0

    # Raw text analysis
    paragraph_count: int = 0
    quote_count: int = 0
    question_count: int = 0
    exclamation_count: int = 0
    all_caps_word_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in self.__dict__.items()}

    def get_factors(self) -> List[Dict[str, Any]]:
        """
        Returns human-readable factors - the ONLY output we show users.
        Legal: These are observable signals, not truth claims.
        """
        factors = []

        factors.append({
            "factor": "source_accuracy_history",
            "label": "Source Historical Accuracy",
            "value": f"{self.source_historical_accuracy:.0%}",
            "description": self._get_source_accuracy_desc(),
            "weight": "high",
            "verdict": "positive" if self.source_historical_accuracy > 0.7 else "neutral" if self.source_historical_accuracy > 0.4 else "concern"
        })

        if self.citation_count > 0:
            factors.append({
                "factor": "source_citations",
                "label": "Sources Cited",
                "value": f"{self.citation_count} sources",
                "description": f"Cites {self.citation_count} external sources with {self.citation_quality_score:.0%} average credibility",
                "weight": "high",
                "verdict": "positive" if self.citation_quality_score > 0.6 else "neutral" if self.citation_quality_score > 0.3 else "concern"
            })
        else:
            factors.append({
                "factor": "no_citations",
                "label": "No External Sources",
                "value": "No citations found",
                "description": "Article does not cite external sources - claims cannot be easily verified",
                "weight": "high",
                "verdict": "concern"
            })

        factors.append({
            "factor": "factual_density",
            "label": "Factual Specificity",
            "value": f"{self.factual_density:.0%}",
            "description": "Ratio of specific facts (numbers, dates, names) to general claims",
            "weight": "medium",
            "verdict": "positive" if self.factual_density > 0.15 else "neutral" if self.factual_density > 0.05 else "concern"
        })

        if self.emotional_language_ratio > 0.05:
            factors.append({
                "factor": "emotional_language",
                "label": "Emotional Language",
                "value": f"{self.emotional_language_ratio:.0%}",
                "description": f"High emotional language may indicate opinion over fact",
                "weight": "medium",
                "verdict": "concern" if self.emotional_language_ratio > 0.1 else "neutral"
            })

        if self.sensationalism_score > 0.3:
            factors.append({
                "factor": "sensationalism",
                "label": "Sensationalist Style",
                "value": f"{self.sensationalism_score:.0%}",
                "description": "Uses ALL CAPS, excessive punctuation, or clickbait phrases",
                "weight": "medium",
                "verdict": "concern"
            })

        factors.append({
            "factor": "source_transparency",
            "label": "Source Transparency",
            "value": f"{self.source_transparency_score:.0%}",
            "description": "Source discloses ownership, methodology, and corrections policy",
            "weight": "medium",
            "verdict": "positive" if self.source_transparency_score > 0.6 else "neutral" if self.source_transparency_score > 0.3 else "concern"
        })

        factors.append({
            "factor": "source_expertise",
            "label": "Topic Expertise",
            "value": f"{self.source_topic_expertise:.0%}",
            "description": f"Source has covered this topic {int(self.source_topic_expertise * 100)}% of the time",
            "weight": "low",
            "verdict": "positive" if self.source_topic_expertise > 0.5 else "neutral"
        })

        factors.append({
            "factor": "cross_source",
            "label": "Cross-Source Verification",
            "value": f"{self.cross_source_count} sources",
            "description": f"Story appears on {self.cross_source_count} other credible sources",
            "weight": "high",
            "verdict": "positive" if self.cross_source_count >= 3 else "neutral" if self.cross_source_count >= 1 else "concern"
        })

        if self.has_author and self.has_dateline:
            factors.append({
                "factor": "attribution",
                "label": "Proper Attribution",
                "value": "Author and dateline present",
                "description": "Article has named author and publication date/location",
                "weight": "low",
                "verdict": "positive"
            })

        return factors

    def _get_source_accuracy_desc(self) -> str:
        if self.source_historical_accuracy > 0.85:
            return "Source has strong history of accurate reporting"
        elif self.source_historical_accuracy > 0.7:
            return "Source has moderate history of accurate reporting"
        elif self.source_historical_accuracy > 0.5:
            return "Source has mixed accuracy history"
        else:
            return "Source has limited verifiable accuracy history"


class CredibilityFeatureExtractor:
    def __init__(self, db_pool=None):
        self.db_pool = db_pool

    def extract(self, article: Dict[str, Any]) -> CredibilitySignals:
        """Extract all credibility signals from an article."""
        signals = CredibilitySignals()

        title = article.get('title', '') or ''
        body = article.get('body', '') or ''
        source_id = article.get('source_id')
        published_at = article.get('published_at')
        url = article.get('url', '') or ''

        signals.word_count = len(body.split()) if body else 0

        self._extract_source_signals(signals, source_id)
        self._extract_content_signals(signals, title, body, url)
        self._extract_network_signals(signals, article)
        self._extract_temporal_signals(signals, published_at)
        self._extract_text_metrics(signals, title, body)

        return signals

    def _extract_source_signals(self, signals: CredibilitySignals, source_id: Optional[int]):
        """Extract signals about the source outlet."""
        if not source_id or not self.db_pool:
            return

        import psycopg2
        try:
            with self.db_pool.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT
                            s.accuracy_score,
                            s.error_rate,
                            s.founded_year,
                            s.has_corrections_policy,
                            s.corrections_count,
                            s.url as source_url
                        FROM news_sources s
                        WHERE s.id = %s
                    """, (source_id,))
                    row = cur.fetchone()

                    if row:
                        signals.source_historical_accuracy = row[0] or 0.5
                        signals.source_error_rate = row[1] or 0.0
                        founded_year = row[2]
                        if founded_year:
                            signals.source_age_years = (2026 - founded_year)
                        signals.source_has_corrections_policy = bool(row[3])
                        signals.source_transparency_score = self._calc_transparency(
                            bool(row[3]), row[4] or 0, signals.source_age_years
                        )
                        source_url = row[5] or ''
                        signals.source_domain_credibility = self._get_domain_credibility(source_url)
        except Exception:
            pass

    def _calc_transparency(self, has_corrections: bool, corrections_count: int, age_years: float) -> float:
        score = 0.3
        if has_corrections:
            score += 0.2
        if corrections_count > 0:
            score += min(0.1, corrections_count * 0.02)
        if age_years > 10:
            score += 0.2
        elif age_years > 5:
            score += 0.1
        if age_years > 20:
            score += 0.2
        return min(1.0, score)

    def _get_domain_credibility(self, url: str) -> float:
        if not url:
            return 0.5
        for domain, cred in CITED_DOMAIN_CREDIBILITY.items():
            if domain in url.lower():
                return cred
        return 0.5

    def _extract_content_signals(self, signals: CredibilitySignals, title: str, body: str, url: str):
        """Extract signals from article content."""
        full_text = f"{title} {body}"

        signals.citation_count, signals.citation_quality_score = self._extract_citations(body)
        signals.factual_density = self._calc_factual_density(full_text)
        signals.emotional_language_ratio = self._calc_emotional_ratio(full_text)
        signals.sensationalism_score = self._calc_sensationalism(title, body)
        signals.specificity_score = self._calc_specificity(full_text)
        signals.claim_verifiability = self._calc_verifiability(full_text)

        signals.has_dateline = bool(re.search(r'\b(Reuters|AP|AFP)\b', body[:500]))
        signals.has_author = bool(re.search(r'\bby\s+[A-Z][a-z]+', body[:500], re.I))

    def _extract_citations(self, text: str) -> tuple:
        matches = CITATION_PATTERN.findall(text)
        if not matches:
            return 0, 0.0

        quality_scores = []
        for domain in matches[:10]:
            domain_lower = domain.lower()
            for known, score in CITED_DOMAIN_CREDIBILITY.items():
                if known in domain_lower:
                    quality_scores.append(score)
                    break
            else:
                quality_scores.append(0.3)

        return len(matches), sum(quality_scores) / len(quality_scores) if quality_scores else 0

    def _calc_factual_density(self, text: str) -> float:
        fact_count = 0
        for pattern in FACTUAL_PATTERNS:
            fact_count += len(re.findall(pattern, text, re.I))
        word_count = len(text.split())
        return min(1.0, fact_count / max(1, word_count) * 10)

    def _calc_emotional_ratio(self, text: str) -> float:
        words = text.lower().split()
        if not words:
            return 0.0
        emotional_count = sum(1 for w in words if w in EMOTIONAL_WORDS)
        return min(1.0, emotional_count / len(words) * 10)

    def _calc_sensationalism(self, title: str, body: str) -> float:
        score = 0.0
        for pattern in SENSATIONAL_PATTERNS:
            if re.search(pattern, title, re.I):
                score += 0.3
            if re.search(pattern, body, re.I):
                score += 0.1
        return min(1.0, score)

    def _calc_specificity(self, text: str) -> float:
        specific_indicators = 0
        if re.search(r'\bdestroyed|devastated|catastrophic|total collapse\b', text, re.I):
            specific_indicators -= 2
        if re.search(r'\b(?:exactly|precisely|specifically|exactly|specifically)\b', text, re.I):
            specific_indicators += 1
        specific_indicators += len(re.findall(r'\d{4}', text)) * 0.5
        specific_indicators += len(re.findall(r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b', text)) * 0.3
        return max(0, min(1, 0.3 + specific_indicators * 0.1))

    def _calc_verifiability(self, text: str) -> float:
        verifiable = 0
        verifiable += len(re.findall(r'\d{4}-\d{2}-\d{2}', text))
        verifiable += len(re.findall(r'\b(?:governor|senator|president|ceo)\s+[A-Z]', text))
        verifiable += len(re.findall(r'https?://\S+', text))
        unverifiable = len(re.findall(r'\b(?:some say|experts say|they say|sources say|reportedly)\b', text, re.I))
        return max(0, min(1, (verifiable - unverifiable * 0.5) / max(1, len(text.split())) * 1000))

    def _extract_network_signals(self, signals: CredibilitySignals, article: Dict[str, Any]):
        """Extract cross-source verification signals."""
        title_hash = article.get('title_hash') or article.get('content_hash')
        if not title_hash and 'title' in article:
            import hashlib
            signals.source_outlier_score = 0.5
            return

        if not self.db_pool:
            return

        import psycopg as pg
        try:
            with self.db_pool.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT COUNT(DISTINCT source_id), AVG(s.accuracy_score)
                        FROM articles a
                        JOIN news_sources s ON a.source_id = s.id
                        WHERE a.title_hash = %s AND a.id != %s
                    """, (title_hash, article.get('id', 0)))
                    row = cur.fetchone()
                    if row and row[0]:
                        signals.cross_source_count = row[0]
                        signals.cross_source_credibility_avg = row[1] or 0.5
                        signals.source_outlier_score = 1.0 / (1 + row[0])
        except Exception:
            pass

    def _extract_temporal_signals(self, signals: CredibilitySignals, published_at: Optional[str]):
        """Extract temporal signals."""
        if published_at:
            try:
                if isinstance(published_at, str):
                    dt = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
                else:
                    dt = published_at
                signals.publication_hour = dt.hour
                signals.is_business_hours = 8 <= dt.hour <= 18 and dt.weekday() < 5
            except Exception:
                pass

        import re
        dates_in_text = re.findall(r'\b(20\d{2})\b', article.get('body', '')[:2000])
        if dates_in_text:
            try:
                most_recent = max(int(d) for d in dates_in_text)
                signals.sources_recency_days = (2026 - most_recent) * 365
            except Exception:
                pass

    def _extract_text_metrics(self, signals: CredibilitySignals, title: str, body: str):
        """Extract basic text metrics."""
        signals.paragraph_count = body.count('\n\n') if body else 0
        signals.quote_count = body.count('"') // 2 if body else 0
        signals.question_count = body.count('?') if body else 0
        signals.exclamation_count = body.count('!') if body else 0
        signals.all_caps_word_count = len(re.findall(r'\b[A-Z]{5,}\b', f"{title} {body}"))


def extract_credibility_signals(article: Dict[str, Any], db_pool=None) -> CredibilitySignals:
    """Convenience function."""
    extractor = CredibilityFeatureExtractor(db_pool)
    return extractor.extract(article)
