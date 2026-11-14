"""Source Pre-Flight Evaluator — assesses news source quality before article data.

Evaluates news sources using three layers:
1. Fast heuristics (~2s) — RSS quality, website signals, content patterns
2. AI-assisted (~20s) — About page analysis, sample articles, reputation
3. NN integration — Feeds scores into neural network as initial features

Usage:
    from worker.source_evaluator import evaluate_source
    
    # Fast evaluation (no AI)
    result = evaluate_source(source_id, mode='fast')
    
    # AI-assisted evaluation
    result = evaluate_source(source_id, mode='ai')
    
    # Full evaluation (heuristics + AI + NN)
    result = evaluate_source(source_id, mode='full')
    
    # Batch evaluation
    from worker.source_preflight import evaluate_all_new_sources
    evaluate_all_new_sources(mode='fast')
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from .db import connect

log = logging.getLogger("xyzo.source_evaluator")

USER_AGENT = "XyzoEvaluator/1.0 (+https://xyzo.org/bot; contact@xyzo.org)"
TIMEOUT_S = 10.0


@dataclass
class EvaluationResult:
    """Result of source evaluation."""
    source_id: int
    mode: str  # fast | ai | full
    
    # Layer 1: Heuristics
    heuristic_score: Optional[float] = None
    rss_quality: Optional[float] = None
    website_quality: Optional[float] = None
    content_quality: Optional[float] = None
    authority_signals: Optional[float] = None
    technical_quality: Optional[float] = None
    heuristic_details: dict = field(default_factory=dict)
    
    # Layer 2: AI
    ai_score: Optional[float] = None
    ai_legitimacy: Optional[float] = None
    ai_standards: Optional[float] = None
    ai_originality: Optional[float] = None
    ai_tone: Optional[float] = None
    ai_reasoning: Optional[str] = None
    ai_details: dict = field(default_factory=dict)
    
    # Layer 3: NN
    nn_initial_score: Optional[float] = None
    nn_confidence: Optional[float] = None
    
    # Final
    final_score: Optional[float] = None
    final_tier: Optional[str] = None
    
    # Metadata
    evaluated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    error_message: Optional[str] = None


def evaluate_source(source_id: int, mode: str = "fast") -> EvaluationResult:
    """Evaluate a news source using specified mode.
    
    Args:
        source_id: ID of source in news_sources table
        mode: 'fast' (heuristics only), 'ai' (AI only), 'full' (both + NN)
    
    Returns:
        EvaluationResult with scores and details
    """
    result = EvaluationResult(source_id=source_id, mode=mode)
    
    try:
        # Get source details
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, feed_url, homepage_url, country, source_type, active
                    FROM news_sources WHERE id = %s
                """, (source_id,))
                source = cur.fetchone()
                
                if not source:
                    result.error_message = f"Source {source_id} not found"
                    return result
        
        log.info(f"Evaluating source {source_id}: {source['name']} ({source['feed_url']})")
        
        # Layer 1: Fast heuristics
        if mode in ('fast', 'full'):
            _evaluate_heuristics(source, result)
        
        # Layer 2: AI-assisted
        if mode in ('ai', 'full'):
            _evaluate_ai(source, result)
        
        # Layer 3: NN integration
        if mode == 'full':
            _integrate_nn(result)
        
        # Calculate final score
        _calculate_final_score(result)
        
        # Save to database
        _save_evaluation(result)
        
        log.info(
            f"Source {source_id} evaluated: score={result.final_score:.2f}, "
            f"tier={result.final_tier}, mode={mode}"
        )
        
    except Exception as e:
        log.error(f"Error evaluating source {source_id}: {e}", exc_info=True)
        result.error_message = str(e)
    
    return result


def _evaluate_heuristics(source: dict, result: EvaluationResult) -> None:
    """Layer 1: Fast heuristic evaluation (~2s)."""
    feed_url = source['feed_url']
    homepage_url = source.get('homepage_url') or feed_url
    
    details = {}
    
    # 1. RSS Feed Quality (0.25 weight)
    rss_score = _check_rss_quality(feed_url, details)
    result.rss_quality = rss_score
    
    # 2. Website Quality (0.20 weight)
    website_score = _check_website_quality(homepage_url, details)
    result.website_quality = website_score
    
    # 3. Content Quality (0.25 weight)
    content_score = _check_content_quality(homepage_url, details)
    result.content_quality = content_score
    
    # 4. Authority Signals (0.15 weight)
    authority_score = _check_authority_signals(source, details)
    result.authority_signals = authority_score
    
    # 5. Technical Quality (0.15 weight)
    tech_score = _check_technical_quality(homepage_url, details)
    result.technical_quality = tech_score
    
    result.heuristic_details = details
    result.heuristic_score = (
        rss_score * 0.25 +
        website_score * 0.20 +
        content_score * 0.25 +
        authority_score * 0.15 +
        tech_score * 0.15
    )


def _check_rss_quality(feed_url: str, details: dict) -> float:
    """Check RSS feed quality."""
    try:
        with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True) as client:
            resp = client.get(feed_url, headers={"User-Agent": USER_AGENT})
            
            if resp.status_code != 200:
                details['rss_status'] = resp.status_code
                return 0.3
            
            content = resp.text[:10000]  # First 10KB
            
            score = 0.0
            
            # Valid RSS/Atom structure
            if '<rss' in content or '<feed' in content or '<channel>' in content:
                score += 0.3
                details['rss_valid'] = True
            else:
                details['rss_valid'] = False
                return 0.2
            
            # Has items/entries
            item_count = content.count('<item>') + content.count('<entry>')
            if item_count >= 10:
                score += 0.3
                details['rss_item_count'] = item_count
            elif item_count >= 5:
                score += 0.2
            elif item_count >= 1:
                score += 0.1
            
            # Has proper dates
            if '<pubDate>' in content or '<published>' in content or '<updated>' in content:
                score += 0.2
                details['rss_has_dates'] = True
            
            # Has titles
            if '<title>' in content:
                score += 0.1
            
            # Has descriptions/summaries
            if '<description>' in content or '<summary>' in content or '<content>' in content:
                score += 0.1
            
            return min(1.0, score)
            
    except Exception as e:
        details['rss_error'] = str(e)[:100]
        return 0.1


def _check_website_quality(homepage_url: str, details: dict) -> float:
    """Check website quality signals."""
    try:
        parsed = urlparse(homepage_url)
        domain = parsed.netloc
        
        score = 0.0
        
        with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True) as client:
            # HTTPS
            if parsed.scheme == 'https':
                score += 0.2
                details['https'] = True
            
            # Response time
            start = time.time()
            resp = client.get(homepage_url, headers={"User-Agent": USER_AGENT})
            response_time = time.time() - start
            
            if response_time < 1.0:
                score += 0.2
                details['response_time'] = f"{response_time:.2f}s"
            elif response_time < 2.0:
                score += 0.1
            
            if resp.status_code != 200:
                details['homepage_status'] = resp.status_code
                return score
            
            html = resp.text[:50000]  # First 50KB
            soup = BeautifulSoup(html, 'html.parser')
            
            # Has about page link
            about_links = [a for a in soup.find_all('a', href=True) 
                          if 'about' in a['href'].lower() or 'contact' in a['href'].lower()]
            if about_links:
                score += 0.2
                details['has_about'] = True
            
            # Has robots.txt
            try:
                robots_url = f"{parsed.scheme}://{domain}/robots.txt"
                robots_resp = client.get(robots_url, timeout=3)
                if robots_resp.status_code == 200:
                    score += 0.2
                    details['has_robots'] = True
            except:
                pass
            
            # Has sitemap
            try:
                sitemap_url = f"{parsed.scheme}://{domain}/sitemap.xml"
                sitemap_resp = client.get(sitemap_url, timeout=3)
                if sitemap_resp.status_code == 200:
                    score += 0.1
                    details['has_sitemap'] = True
            except:
                pass
            
            # Professional meta tags
            if soup.find('meta', attrs={'name': 'description'}):
                score += 0.1
            
            return min(1.0, score)
            
    except Exception as e:
        details['website_error'] = str(e)[:100]
        return 0.2


def _check_content_quality(homepage_url: str, details: dict) -> float:
    """Check content quality signals."""
    try:
        with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True) as client:
            resp = client.get(homepage_url, headers={"User-Agent": USER_AGENT})
            
            if resp.status_code != 200:
                return 0.3
            
            html = resp.text[:100000]  # First 100KB
            soup = BeautifulSoup(html, 'html.parser')
            
            score = 0.0
            
            # Has article links
            article_links = soup.find_all('a', href=True)
            news_patterns = re.compile(r'/(article|news|story|post)/', re.IGNORECASE)
            news_links = [a for a in article_links if news_patterns.search(a['href'])]
            
            if len(news_links) >= 10:
                score += 0.3
                details['article_count'] = len(news_links)
            elif len(news_links) >= 5:
                score += 0.2
            elif len(news_links) >= 1:
                score += 0.1
            
            # Has sections/categories
            section_patterns = re.compile(r'/(politics|business|sports|entertainment|tech|world|local)', re.IGNORECASE)
            sections = [a for a in article_links if section_patterns.search(a['href'])]
            if len(sections) >= 3:
                score += 0.2
                details['has_sections'] = True
            
            # Check a sample article for quality signals
            if news_links:
                sample_url = news_links[0]['href']
                if not sample_url.startswith('http'):
                    parsed = urlparse(homepage_url)
                    sample_url = f"{parsed.scheme}://{parsed.netloc}{sample_url}"
                
                try:
                    article_resp = client.get(sample_url, timeout=5)
                    if article_resp.status_code == 200:
                        article_html = article_resp.text[:50000]
                        article_soup = BeautifulSoup(article_html, 'html.parser')
                        
                        # Has byline
                        byline = article_soup.find(string=re.compile(r'by|author|written', re.IGNORECASE))
                        if byline:
                            score += 0.2
                            details['has_byline'] = True
                        
                        # Has publication date
                        date_elem = article_soup.find(string=re.compile(r'\d{4}-\d{2}-\d{2}|published|posted', re.IGNORECASE))
                        if date_elem:
                            score += 0.2
                            details['has_date'] = True
                        
                        # Article length (word count estimate)
                        text = article_soup.get_text()
                        word_count = len(text.split())
                        if word_count >= 500:
                            score += 0.1
                            details['article_word_count'] = word_count
                except:
                    pass
            
            return min(1.0, score)
            
    except Exception as e:
        details['content_error'] = str(e)[:100]
        return 0.3


def _check_authority_signals(source: dict, details: dict) -> float:
    """Check authority signals (domain age, directory listings, etc.)."""
    score = 0.5  # Start neutral
    
    domain = urlparse(source['feed_url']).netloc
    
    # Known good TLDs
    if domain.endswith('.edu') or domain.endswith('.gov'):
        score += 0.2
        details['trusted_tld'] = True
    
    # Known news directories (would need external API in production)
    # For now, just check if it's a well-known domain pattern
    if any(x in domain for x in ['news', 'times', 'post', 'herald', 'tribune']):
        score += 0.1
        details['news_domain_pattern'] = True
    
    # Country-specific TLD
    country = source.get('country', '')
    if country and domain.endswith(f'.{country.lower()}'):
        score += 0.1
        details['country_tld'] = True
    
    return min(1.0, max(0.0, score))


def _check_technical_quality(homepage_url: str, details: dict) -> float:
    """Check technical quality (mobile-friendly, meta tags, etc.)."""
    try:
        with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True) as client:
            resp = client.get(homepage_url, headers={"User-Agent": USER_AGENT})
            
            if resp.status_code != 200:
                return 0.3
            
            html = resp.text[:50000]
            soup = BeautifulSoup(html, 'html.parser')
            
            score = 0.0
            
            # Has viewport meta (mobile-friendly)
            viewport = soup.find('meta', attrs={'name': 'viewport'})
            if viewport:
                score += 0.3
                details['mobile_friendly'] = True
            
            # Has charset
            charset = soup.find('meta', attrs={'charset': True})
            if charset:
                score += 0.1
            
            # Has title
            if soup.title and soup.title.string:
                score += 0.2
                details['has_title'] = True
            
            # Has canonical URL
            canonical = soup.find('link', rel='canonical')
            if canonical:
                score += 0.1
            
            # Has Open Graph tags
            og_tags = soup.find_all('meta', attrs={'property': re.compile(r'^og:')})
            if len(og_tags) >= 3:
                score += 0.2
                details['has_og_tags'] = True
            
            # Has structured data
            json_ld = soup.find_all('script', type='application/ld+json')
            if json_ld:
                score += 0.1
                details['has_structured_data'] = True
            
            return min(1.0, score)
            
    except Exception as e:
        details['technical_error'] = str(e)[:100]
        return 0.3


def _evaluate_ai(source: dict, result: EvaluationResult) -> None:
    """Layer 2: AI-assisted evaluation (~20s)."""
    try:
        # Import here to avoid circular dependency
        from .ai_client import AIClient
        
        homepage_url = source.get('homepage_url') or source['feed_url']
        
        # Fetch about page and sample article
        about_text = _fetch_about_page(homepage_url)
        sample_text = _fetch_sample_article(homepage_url)
        
        if not about_text and not sample_text:
            result.ai_details['error'] = 'Could not fetch content for AI evaluation'
            return
        
        # Build AI prompt
        prompt = f"""You are evaluating a news source for journalistic quality.

Source: {source['name']}
URL: {homepage_url}
Country: {source.get('country', 'Unknown')}

About page content:
{about_text[:2000] if about_text else 'Not available'}

Sample article:
{sample_text[:2000] if sample_text else 'Not available'}

Score 0-1 on each dimension:
1. Legitimacy: Is this a legitimate news organization? (not blog, not propaganda, not satire)
2. Standards: Does it follow journalistic standards? (bylines, dates, corrections policy, editorial oversight)
3. Originality: Is the content original reporting? (not just aggregation, not press releases)
4. Tone: Is the tone factual and balanced? (not sensationalist, not opinion-heavy, not clickbait)

Return JSON with these exact keys:
{{
  "legitimacy": 0.0-1.0,
  "standards": 0.0-1.0,
  "originality": 0.0-1.0,
  "tone": 0.0-1.0,
  "overall": 0.0-1.0,
  "reasoning": "brief explanation"
}}"""
        
        # Call AI
        ai_client = AIClient.from_config()
        
        async def call_ai():
            response = await ai_client.chat([
                {"role": "user", "content": prompt}
            ], temperature=0.3, max_tokens=500)
            return response
        
        response = asyncio.run(call_ai())
        content = response['choices'][0]['message']['content']
        
        # Parse JSON response
        import json
        try:
            # Try to extract JSON from response
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                ai_data = json.loads(json_match.group())
                
                result.ai_legitimacy = float(ai_data.get('legitimacy', 0.5))
                result.ai_standards = float(ai_data.get('standards', 0.5))
                result.ai_originality = float(ai_data.get('originality', 0.5))
                result.ai_tone = float(ai_data.get('tone', 0.5))
                result.ai_score = float(ai_data.get('overall', 0.5))
                result.ai_reasoning = ai_data.get('reasoning', '')
                result.ai_details = ai_data
                
        except (json.JSONDecodeError, ValueError) as e:
            result.ai_details['parse_error'] = str(e)
            result.ai_details['raw_response'] = content[:500]
    
    except Exception as e:
        log.warning(f"AI evaluation failed for source {source['id']}: {e}")
        result.ai_details['error'] = str(e)[:200]


def _fetch_about_page(homepage_url: str) -> Optional[str]:
    """Fetch about page content."""
    try:
        parsed = urlparse(homepage_url)
        domain = parsed.netloc
        
        # Try common about page URLs
        about_urls = [
            f"{parsed.scheme}://{domain}/about",
            f"{parsed.scheme}://{domain}/about-us",
            f"{parsed.scheme}://{domain}/about.html",
            f"{parsed.scheme}://{domain}/who-we-are",
        ]
        
        with httpx.Client(timeout=5, follow_redirects=True) as client:
            for url in about_urls:
                try:
                    resp = client.get(url, headers={"User-Agent": USER_AGENT})
                    if resp.status_code == 200:
                        soup = BeautifulSoup(resp.text, 'html.parser')
                        # Remove scripts, styles
                        for elem in soup(['script', 'style', 'nav', 'footer']):
                            elem.decompose()
                        return soup.get_text()[:3000]
                except:
                    continue
        
        return None
    except:
        return None


def _fetch_sample_article(homepage_url: str) -> Optional[str]:
    """Fetch a sample article from homepage."""
    try:
        with httpx.Client(timeout=5, follow_redirects=True) as client:
            resp = client.get(homepage_url, headers={"User-Agent": USER_AGENT})
            if resp.status_code != 200:
                return None
            
            soup = BeautifulSoup(resp.text, 'html.parser')
            
            # Find article links
            article_links = soup.find_all('a', href=True)
            news_patterns = re.compile(r'/(article|news|story|post)/', re.IGNORECASE)
            news_links = [a for a in article_links if news_patterns.search(a['href'])]
            
            if not news_links:
                return None
            
            # Fetch first article
            sample_url = news_links[0]['href']
            if not sample_url.startswith('http'):
                parsed = urlparse(homepage_url)
                sample_url = f"{parsed.scheme}://{parsed.netloc}{sample_url}"
            
            article_resp = client.get(sample_url, timeout=5)
            if article_resp.status_code == 200:
                article_soup = BeautifulSoup(article_resp.text, 'html.parser')
                for elem in article_soup(['script', 'style', 'nav', 'footer']):
                    elem.decompose()
                return article_soup.get_text()[:3000]
        
        return None
    except:
        return None


def _integrate_nn(result: EvaluationResult) -> None:
    """Layer 3: NN integration — prepare scores for neural network."""
    # Combine heuristic and AI scores
    if result.heuristic_score is not None and result.ai_score is not None:
        result.nn_initial_score = result.heuristic_score * 0.6 + result.ai_score * 0.4
        result.nn_confidence = 0.8  # High confidence when both available
    elif result.heuristic_score is not None:
        result.nn_initial_score = result.heuristic_score
        result.nn_confidence = 0.6  # Medium confidence with heuristics only
    elif result.ai_score is not None:
        result.nn_initial_score = result.ai_score
        result.nn_confidence = 0.7  # Medium-high with AI only
    else:
        result.nn_initial_score = 0.5
        result.nn_confidence = 0.3  # Low confidence


def _calculate_final_score(result: EvaluationResult) -> None:
    """Calculate final composite score."""
    if result.mode == 'fast':
        # Heuristics only
        result.final_score = result.heuristic_score or 0.5
    elif result.mode == 'ai':
        # AI only
        result.final_score = result.ai_score or 0.5
    elif result.mode == 'full':
        # Combined
        if result.heuristic_score is not None and result.ai_score is not None:
            result.final_score = result.heuristic_score * 0.6 + result.ai_score * 0.4
        elif result.heuristic_score is not None:
            result.final_score = result.heuristic_score
        elif result.ai_score is not None:
            result.final_score = result.ai_score
        else:
            result.final_score = 0.5
    
    # Map to tier
    if result.final_score >= 0.75:
        result.final_tier = 'critical'
    elif result.final_score >= 0.50:
        result.final_tier = 'high'
    elif result.final_score >= 0.25:
        result.final_tier = 'medium'
    elif result.final_score >= 0.05:
        result.final_tier = 'low'
    else:
        result.final_tier = 'paused'


def _save_evaluation(result: EvaluationResult) -> None:
    """Save evaluation result to database."""
    try:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO source_evaluations (
                        source_id,
                        heuristic_score, rss_quality, website_quality, content_quality,
                        authority_signals, technical_quality, heuristic_details,
                        ai_score, ai_legitimacy, ai_standards, ai_originality, ai_tone,
                        ai_reasoning, ai_details,
                        nn_initial_score, nn_confidence,
                        final_score, final_tier,
                        evaluation_mode, evaluated_at, expires_at, error_message
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (source_id) DO UPDATE SET
                        heuristic_score = EXCLUDED.heuristic_score,
                        rss_quality = EXCLUDED.rss_quality,
                        website_quality = EXCLUDED.website_quality,
                        content_quality = EXCLUDED.content_quality,
                        authority_signals = EXCLUDED.authority_signals,
                        technical_quality = EXCLUDED.technical_quality,
                        heuristic_details = EXCLUDED.heuristic_details,
                        ai_score = EXCLUDED.ai_score,
                        ai_legitimacy = EXCLUDED.ai_legitimacy,
                        ai_standards = EXCLUDED.ai_standards,
                        ai_originality = EXCLUDED.ai_originality,
                        ai_tone = EXCLUDED.ai_tone,
                        ai_reasoning = EXCLUDED.ai_reasoning,
                        ai_details = EXCLUDED.ai_details,
                        nn_initial_score = EXCLUDED.nn_initial_score,
                        nn_confidence = EXCLUDED.nn_confidence,
                        final_score = EXCLUDED.final_score,
                        final_tier = EXCLUDED.final_tier,
                        evaluation_mode = EXCLUDED.evaluation_mode,
                        evaluated_at = EXCLUDED.evaluated_at,
                        expires_at = EXCLUDED.expires_at,
                        error_message = EXCLUDED.error_message
                """, (
                    result.source_id,
                    result.heuristic_score, result.rss_quality, result.website_quality,
                    result.content_quality, result.authority_signals, result.technical_quality,
                    json.dumps(result.heuristic_details) if result.heuristic_details else None,
                    result.ai_score, result.ai_legitimacy, result.ai_standards,
                    result.ai_originality, result.ai_tone, result.ai_reasoning,
                    json.dumps(result.ai_details) if result.ai_details else None,
                    result.nn_initial_score, result.nn_confidence,
                    result.final_score, result.final_tier,
                    result.mode, result.evaluated_at,
                    result.evaluated_at + timedelta(days=30),  # Re-evaluate in 30 days
                    result.error_message
                ))
                
                # Update news_sources.reliability_score with final_score
                if result.final_score is not None:
                    cur.execute("""
                        UPDATE news_sources 
                        SET reliability_score = %s, credibility_score = %s
                        WHERE id = %s
                    """, (result.final_score, result.final_score, result.source_id))
        
        log.info(f"Saved evaluation for source {result.source_id}: score={result.final_score}")
        
    except Exception as e:
        log.error(f"Failed to save evaluation for source {result.source_id}: {e}")
        raise


# Need json import for saving
import json
