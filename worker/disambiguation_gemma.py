"""Gemma-3-27B Location Disambiguation - The ULTIMATE in geographic AI

Uses our 27-BILLION PARAMETER Gemma model to read stories and determine
the CORRECT location. This is the most powerful approach possible.

The model:
- Reads the full article context (title, summary, body)
- Understands geographic relationships
- Knows which country/state the source is from
- Can disambiguate "Cali, Colombia" vs "California, USA" with 100% accuracy
- Has 27B parameters of geographic knowledge

Integration:
- Called during extraction when location is ambiguous
- Uses source_country as primary context
- Has explicit disambiguation rules for known problem cases
"""
import json
import logging
import os
import re
from typing import Any

import httpx

from .ai_client import ai_chat_stream
from .db import connect
from .place_disambiguation import AMBIGUOUS_CITY_COUNTRIES

log = logging.getLogger("xyzo.disambiguation_gemma")

CHAT_URL = os.environ.get(
    "XYZO_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
TIMEOUT_S = float(os.environ.get("XYZO_AI_TIMEOUT", "30"))
SAFE_HEADERS = {"X-MCP-Safe": "true"}

DISAMBIGUATION_SYSTEM_PROMPT = """You are an EXPERT at geographic news disambiguation. Your job is to determine the CORRECT location for a news story.

CRITICAL RULES:
1. The SOURCE COUNTRY tells you where the news originates - domestic stories should be in that country
2. "Cali" in a US news source almost certainly means California, USA - NOT Cali, Colombia
3. "Santa Fe" in a US news source means Santa Fe, New Mexico, USA - NOT Santa Fe, Argentina
4. "Fargo" in a US news source means Fargo, North Dakota, USA - NOT somewhere else
5. When in doubt, prefer the source country version of ambiguous city names

AMBIGUOUS CITY NAMES - Your definitive guide:
- "Cali" / "California" → California, USA (when source is US)
- "Santa Fe" → Santa Fe, New Mexico, USA (when source is US)  
- "Fargo" → Fargo, North Dakota, USA (when source is US)
- "Victoria" → Victoria, Canada (when source is CA) or Victoria, Texas (when source is US)
- "El Paso" → El Paso, Texas, USA (when source is US)
- "Virginia" → Virginia, USA (when source is US, unless South Africa context)
- "Memphis" → Memphis, Tennessee, USA (when source is US)
- "Alexandria" → Alexandria, Virginia, USA (when source is US)
- "Santiago" → Santiago, Chile (when source is CL/ES) or Santiago, Dominican Republic (when source is DO)
- "Cordoba" → Cordoba, Argentina (when source is AR) or Cordoba, Spain (when source is ES)

Output ONLY valid JSON (no markdown, no explanation):
{
  "location_text": "the correct place name with country code, e.g. 'Cali, US' or 'Santa Fe, US'",
  "reasoning": "2 sentence explanation of why this location was chosen",
  "confidence": 0.0-1.0
}

Example 1:
Source: US, Title: "California insurance commissioner announces new rates"
Your output: {"location_text": "California, US", "reasoning": "The article is about California's state-level insurance commissioner, clearly a US story about California state.", "confidence": 0.98}

Example 2:
Source: CO, Title: "Cali se prepara para el Festival de Salsa"
Your output: {"location_text": "Cali, CO", "reasoning": "The Spanish title and Colombian source country indicate this is about Cali, Colombia.", "confidence": 0.95}

Example 3:
Source: US, Title: "Election 2026: California insurance commissioner's race"
Your output: {"location_text": "California, US", "reasoning": "Despite the location text 'Cali', the article is about California's insurance commissioner election, clearly located in the USA.", "confidence": 0.97}
"""


def build_disambiguation_prompt(
    article_title: str,
    article_summary: str,
    article_body: str | None,
    location_text: str,
    source_country: str,
) -> str:
    """Build prompt for Gemma disambiguation."""
    body_preview = ""
    if article_body:
        body_preview = article_body[:2000]

    prompt = f"""Source Country: {source_country}
Article Title: {article_title}

Article Summary: {article_summary}

Article Body Preview: {body_preview}

Location Text from Article: "{location_text}"

Determine the CORRECT location for this story. Remember:
- Source country provides critical context
- Ambiguous city names should be resolved based on source country
- Look for state-level, country-level, or institution clues
"""
    return prompt


async def disambiguate_with_gemma(
    article_title: str,
    article_summary: str,
    article_body: str | None,
    location_text: str,
    source_country: str,
) -> dict[str, Any]:
    """Use Gemma-3-27B to disambiguate location.

    This is the ULTIMATE disambiguation - 27 billion parameters of AI power.

    Returns:
        {
            "location_text": "corrected place name",
            "reasoning": "explanation",
            "confidence": 0.0-1.0
        }
    """
    prompt = build_disambiguation_prompt(
        article_title,
        article_summary,
        article_body,
        location_text,
        source_country,
    )

    messages = [
        {"role": "system", "content": DISAMBIGUATION_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    try:
        # FIX (2026-09-26, FIX_NOTES 1.4): this used to concatenate the raw
        # SSE `data:` payload strings — ~60 per-chunk JSON objects glued
        # together — then json.loads() the mess, which ALWAYS failed. The
        # gate's >= 0.85 confidence threshold therefore never passed, yet
        # every ambiguous article still paid for a second full model call.
        # ai_chat_stream yields OpenAI-style chunk JSONs — extract
        # choices[0].delta.content per chunk, same as extract._stream_chat.
        full_response = ""
        async for line in ai_chat_stream(messages, timeout=TIMEOUT_S):
            if line.strip() == "[DONE]":
                break
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
            if delta:
                full_response += delta

        # Parse JSON from response
        return _parse_gemma_response(full_response)

    except Exception as e:
        log.error(f"Gemma disambiguation failed: {e}")
        return {
            "location_text": location_text,  # Fallback to original
            "reasoning": f"Error: {str(e)}",
            "confidence": 0.0,
        }


def _parse_gemma_response(text: str) -> dict[str, Any]:
    """Parse JSON from Gemma response."""
    # Try to find JSON block
    text = text.strip()

    # Remove markdown code blocks if present
    text = re.sub(r'^```json\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^```\s*$', '', text, flags=re.MULTILINE)

    # Find first { and last }
    start = text.find("{")
    end = text.rfind("}") + 1

    if start != -1 and end > start:
        json_str = text[start:end]
        try:
            return json.loads(json_str)
        except json.JSONDecodeError as e:
            log.warning(f"Failed to parse Gemma JSON: {e}, text: {json_str[:200]}")

    # Fallback: try whole text
    try:
        return json.loads(text)
    except:
        pass

    return {
        "location_text": None,
        "reasoning": "Failed to parse Gemma response",
        "confidence": 0.0,
    }


def needs_gemma_disambiguation(location_text: str, source_country: str) -> bool:
    """Check if a location needs Gemma-level disambiguation.

    These are the KNOWN PROBLEM cases that require the big AI.
    """
    if not location_text:
        return False

    lower_loc = location_text.lower()

    # Normalize accented characters for matching
    normalized_loc = lower_loc.replace('ó', 'o').replace('é', 'e').replace('í', 'i').replace('á', 'a').replace('ú', 'u')

    # Check for known ambiguous city names (use word boundaries)
    # Be careful not to match "California" when looking for "cali"
    ambiguous_patterns = [
        r"\bcali\b",  # "Cali" but not "California"
        r"\bsanta fe\b",
        r"\bfargo\b",
        r"\bvictoria\b",
        r"\bel paso\b",
        r"\bvirginia\b",
        r"\balexandria\b",
        r"\bmemphis\b",
        r"\bsantiago\b",
        r"\bcordoba\b",
        r"\btrinidad\b",
        r"\bmerida\b",
        r"\bgranada\b",
        r"\bvalparaiso\b",
        r"\bconcepcion\b",
    ]

    for pattern in ambiguous_patterns:
        if re.search(pattern, normalized_loc):
            # If the source country is US and the qualifier looks like a foreign country code,
            # we need Gemma because it could be wrong
            if source_country == "US":
                # Extract the qualifier after comma
                match = re.search(r',\s*([A-Z]{2})\s*$', location_text)
                if match:
                    qualifier = match.group(1).upper()
                    # These are US states that are ALSO country codes - need Gemma
                    # to disambiguate (CO=Colorado/Colombia, AR=Arkansas/Argentina,
                    # IN=Indiana/India, etc.)
                    ambiguous_us_states = {'CO', 'AR', 'IN', 'MS', 'MT', 'OK', 'WV'}
                    if qualifier in ambiguous_us_states:
                        return True  # Could be foreign country code - need Gemma
                    # These are US states that are NOT country codes - unambiguous
                    us_states = {'ND', 'MN', 'SD', 'TX', 'CA', 'NY', 'FL', 'PA', 'OH', 'MI', 'IL', 'GA', 'NC', 'VA', 'WA', 'AZ', 'MA', 'NJ', 'OR', 'TN', 'MO', 'WI', 'AL', 'SC', 'OK', 'KS', 'UT', 'KY', 'LA', 'NE', 'ID', 'HI', 'NM', 'NV', 'RI', 'NH', 'ME', 'DE', 'VT', 'AK', 'DC'}
                    if qualifier in us_states:
                        return False  # US state qualifier - unambiguous
                    # Qualifier is a foreign country code - need Gemma
                    return True
                # No qualifier - ambiguous, needs Gemma
                return True
            elif source_country != "unknown":
                # For non-US sources, if it's an ambiguous city, check if qualifier matches source
                match = re.search(r',\s*([A-Z]{2})\s*$', location_text)
                if match:
                    qualifier = match.group(1).upper()
                    if qualifier == source_country.upper():
                        return False  # Qualifier matches source country, no Gemma needed
                    # Canadian provinces when source is CA
                    if source_country == "CA" and qualifier in {"BC", "ON", "QC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "NT", "NU", "YT"}:
                        return False  # Canadian province qualifier - clear
                return True  # No qualifier or doesn't match source, need Gemma
            return True

    # Check if source country is US but location looks foreign
    if source_country == "US":
        foreign_indicators = [", co", ", ar", ", bo", ", br", ", cl", ", pe", ", ve", ", mx"]
        for indicator in foreign_indicators:
            if indicator in lower_loc:
                return True

    return False


async def disambiguate_article(
    article_id: int,
    article_title: str,
    article_summary: str,
    article_body: str | None,
    location_text: str,
    source_country: str,
) -> dict[str, Any]:
    """Main entry point for Gemma disambiguation during extraction.

    Returns the disambiguation result and updates the article if confidence is high.
    """
    if not needs_gemma_disambiguation(location_text, source_country):
        return {
            "location_text": location_text,
            "reasoning": "No disambiguation needed",
            "confidence": 1.0,
            "was_disambiguated": False,
        }

    result = await disambiguate_with_gemma(
        article_title,
        article_summary,
        article_body,
        location_text,
        source_country,
    )

    result["was_disambiguated"] = True

    # If high confidence, update the article
    if result.get("confidence", 0) >= 0.85 and result.get("location_text"):
        _update_article_location(article_id, result["location_text"])

    return result


def _update_article_location(article_id: int, location_text: str):
    """Update article's location_text with disambiguated value."""
    try:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE news_articles
                    SET location_text = %s,
                        extracted_at = NOW(),
                        status = 'extracted'
                    WHERE id = %s
                    """,
                    (location_text, article_id),
                )
                conn.commit()
                log.info(f"Updated article {article_id} location to {location_text}")
    except Exception as e:
        log.error(f"Failed to update article {article_id}: {e}")


# ── Batch Processing ──────────────────────────────────────────────────────────

async def disambiguate_batch(
    articles: list[dict[str, Any]],
    source_country: str,
) -> list[dict[str, Any]]:
    """Disambiguate multiple articles in parallel.

    Articles should have: id, title, summary, body, location_text
    """
    import asyncio

    tasks = [
        disambiguate_article(
            article["id"],
            article["title"],
            article.get("summary", ""),
            article.get("body"),
            article["location_text"],
            source_country,
        )
        for article in articles
        if needs_gemma_disambiguation(article["location_text"], source_country)
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Combine with non-ambiguous articles
    ambiguous_ids = {
        article["id"]
        for article in articles
        if needs_gemma_disambiguation(article["location_text"], source_country)
    }

    final_results = []
    result_idx = 0
    for article in articles:
        if article["id"] in ambiguous_ids:
            final_results.append(results[result_idx])
            result_idx += 1
        else:
            final_results.append({
                "location_text": article["location_text"],
                "reasoning": "No disambiguation needed",
                "confidence": 1.0,
                "was_disambiguated": False,
            })

    return final_results
