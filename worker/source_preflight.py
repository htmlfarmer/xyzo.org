"""Source Pre-Flight Batch Evaluator — evaluates all new sources.

Batch evaluates news sources that were recently added to set their initial
reliability_score before the learning loop takes over.

Usage:
    python -m worker.source_preflight --mode fast              # Fast heuristics only
    python -m worker.source_preflight --mode ai                # AI-assisted only
    python -m worker.source_preflight --mode full              # Full evaluation
    python -m worker.source_preflight --country MX             # Specific country
    python -m worker.source_preflight --days 1                 # Sources added in last N days
    python -m worker.source_preflight --re-evaluate            # Re-evaluate expired evaluations
    python -m worker.source_preflight --summary                # Show evaluation summary
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

from .db import connect
from .source_evaluator import evaluate_source

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("xyzo.source_preflight")


def get_sources_to_evaluate(
    country: Optional[str] = None,
    days: int = 7,
    re_evaluate: bool = False,
    limit: Optional[int] = None
) -> list[dict]:
    """Get list of sources that need evaluation.
    
    Args:
        country: Filter by country code (e.g., 'MX', 'BR')
        days: Only evaluate sources added in last N days
        re_evaluate: Include sources with expired evaluations
        limit: Max number of sources to return
    
    Returns:
        List of source dicts with id, name, feed_url, country
    """
    with connect() as conn:
        with conn.cursor() as cur:
            # Base query: sources added recently
            query = """
                SELECT ns.id, ns.name, ns.feed_url, ns.country, ns.source_type
                FROM news_sources ns
                WHERE ns.created_at >= NOW() - INTERVAL '%s days'
            """
            params = [days]
            
            # Filter by country if specified
            if country:
                query += " AND ns.country = %s"
                params.append(country)
            
            # Exclude already evaluated (unless re-evaluating)
            if not re_evaluate:
                query += """
                    AND NOT EXISTS (
                        SELECT 1 FROM source_evaluations se
                        WHERE se.source_id = ns.id
                    )
                """
            else:
                # Include expired evaluations
                query += """
                    AND (
                        NOT EXISTS (
                            SELECT 1 FROM source_evaluations se
                            WHERE se.source_id = ns.id
                        )
                        OR EXISTS (
                            SELECT 1 FROM source_evaluations se
                            WHERE se.source_id = ns.id
                            AND se.expires_at < NOW()
                        )
                    )
                """
            
            query += " ORDER BY ns.created_at DESC"
            
            if limit:
                query += f" LIMIT {limit}"
            
            cur.execute(query, params)
            return cur.fetchall()


def evaluate_batch(
    mode: str = "fast",
    country: Optional[str] = None,
    days: int = 7,
    re_evaluate: bool = False,
    limit: Optional[int] = None,
    delay_between: float = 0.5
) -> dict:
    """Evaluate sources in batch.
    
    Args:
        mode: 'fast', 'ai', or 'full'
        country: Filter by country code
        days: Only evaluate sources added in last N days
        re_evaluate: Include expired evaluations
        limit: Max number of sources to evaluate
        delay_between: Delay between evaluations (seconds)
    
    Returns:
        Summary dict with counts and scores
    """
    sources = get_sources_to_evaluate(country, days, re_evaluate, limit)
    
    if not sources:
        log.info("No sources to evaluate")
        return {"total": 0, "evaluated": 0, "errors": 0}
    
    log.info(f"Evaluating {len(sources)} sources in '{mode}' mode...")
    
    results = {
        "total": len(sources),
        "evaluated": 0,
        "errors": 0,
        "scores": [],
        "tiers": {},
        "by_country": {},
    }
    
    for i, source in enumerate(sources, 1):
        try:
            log.info(f"[{i}/{len(sources)}] Evaluating {source['name']} ({source['country']})")
            
            result = evaluate_source(source['id'], mode=mode)
            
            if result.error_message:
                results["errors"] += 1
                log.warning(f"  Error: {result.error_message}")
            else:
                results["evaluated"] += 1
                results["scores"].append(result.final_score)
                
                # Count by tier
                tier = result.final_tier or "unknown"
                results["tiers"][tier] = results["tiers"].get(tier, 0) + 1
                
                # Count by country
                country = source['country']
                if country not in results["by_country"]:
                    results["by_country"][country] = {"count": 0, "avg_score": 0.0, "scores": []}
                results["by_country"][country]["count"] += 1
                results["by_country"][country]["scores"].append(result.final_score)
                
                log.info(f"  Score: {result.final_score:.3f}, Tier: {tier}")
            
            # Delay to avoid hammering servers
            if i < len(sources):
                time.sleep(delay_between)
        
        except Exception as e:
            log.error(f"Failed to evaluate source {source['id']}: {e}", exc_info=True)
            results["errors"] += 1
    
    # Calculate averages
    if results["scores"]:
        results["avg_score"] = sum(results["scores"]) / len(results["scores"])
        results["min_score"] = min(results["scores"])
        results["max_score"] = max(results["scores"])
    
    for country_data in results["by_country"].values():
        if country_data["scores"]:
            country_data["avg_score"] = sum(country_data["scores"]) / len(country_data["scores"])
        del country_data["scores"]  # Don't keep raw scores in summary
    
    return results


def show_summary() -> None:
    """Show summary of all evaluations."""
    with connect() as conn:
        with conn.cursor() as cur:
            # Overall stats
            cur.execute("""
                SELECT 
                    COUNT(*) as total,
                    AVG(final_score) as avg_score,
                    MIN(final_score) as min_score,
                    MAX(final_score) as max_score,
                    COUNT(CASE WHEN final_tier = 'critical' THEN 1 END) as critical,
                    COUNT(CASE WHEN final_tier = 'high' THEN 1 END) as high,
                    COUNT(CASE WHEN final_tier = 'medium' THEN 1 END) as medium,
                    COUNT(CASE WHEN final_tier = 'low' THEN 1 END) as low,
                    COUNT(CASE WHEN final_tier = 'paused' THEN 1 END) as paused
                FROM source_evaluations
            """)
            stats = cur.fetchone()
            
            print("\n=== Source Evaluation Summary ===\n")
            print(f"Total evaluated: {stats['total']}")
            print(f"Average score: {stats['avg_score']:.3f}")
            print(f"Score range: {stats['min_score']:.3f} - {stats['max_score']:.3f}")
            print(f"\nTier distribution:")
            print(f"  Critical: {stats['critical']}")
            print(f"  High:     {stats['high']}")
            print(f"  Medium:   {stats['medium']}")
            print(f"  Low:      {stats['low']}")
            print(f"  Paused:   {stats['paused']}")
            
            # By country
            cur.execute("""
                SELECT 
                    ns.country,
                    COUNT(*) as count,
                    AVG(se.final_score) as avg_score,
                    COUNT(CASE WHEN se.final_tier = 'critical' THEN 1 END) as critical,
                    COUNT(CASE WHEN se.final_tier = 'high' THEN 1 END) as high
                FROM source_evaluations se
                JOIN news_sources ns ON ns.id = se.source_id
                GROUP BY ns.country
                ORDER BY count DESC
                LIMIT 20
            """)
            countries = cur.fetchall()
            
            print(f"\nTop 20 countries by evaluation count:")
            print(f"{'Country':<8} {'Count':<8} {'Avg Score':<12} {'Critical':<10} {'High':<8}")
            print("-" * 50)
            for row in countries:
                print(f"{row['country']:<8} {row['count']:<8} {row['avg_score']:<12.3f} {row['critical']:<10} {row['high']:<8}")
            
            # Lowest scoring sources
            cur.execute("""
                SELECT ns.name, ns.country, se.final_score, se.final_tier
                FROM source_evaluations se
                JOIN news_sources ns ON ns.id = se.source_id
                ORDER BY se.final_score ASC
                LIMIT 10
            """)
            lowest = cur.fetchall()
            
            print(f"\n10 lowest scoring sources:")
            for row in lowest:
                print(f"  [{row['country']}] {row['name']}: {row['final_score']:.3f} ({row['final_tier']})")
            
            # Highest scoring sources
            cur.execute("""
                SELECT ns.name, ns.country, se.final_score, se.final_tier
                FROM source_evaluations se
                JOIN news_sources ns ON ns.id = se.source_id
                ORDER BY se.final_score DESC
                LIMIT 10
            """)
            highest = cur.fetchall()
            
            print(f"\n10 highest scoring sources:")
            for row in highest:
                print(f"  [{row['country']}] {row['name']}: {row['final_score']:.3f} ({row['final_tier']})")


def main():
    parser = argparse.ArgumentParser(description="Source Pre-Flight Batch Evaluator")
    parser.add_argument(
        "--mode",
        choices=["fast", "ai", "full"],
        default="fast",
        help="Evaluation mode: fast (heuristics), ai (AI-assisted), full (both + NN)"
    )
    parser.add_argument(
        "--country",
        help="Filter by country code (e.g., MX, BR, PH)"
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Only evaluate sources added in last N days (default: 7)"
    )
    parser.add_argument(
        "--re-evaluate",
        action="store_true",
        help="Re-evaluate sources with expired evaluations"
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Maximum number of sources to evaluate"
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.5,
        help="Delay between evaluations in seconds (default: 0.5)"
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Show evaluation summary instead of running evaluations"
    )
    
    args = parser.parse_args()
    
    if args.summary:
        show_summary()
        return
    
    log.info(f"Starting batch evaluation: mode={args.mode}, country={args.country or 'all'}, days={args.days}")
    
    results = evaluate_batch(
        mode=args.mode,
        country=args.country,
        days=args.days,
        re_evaluate=args.re_evaluate,
        limit=args.limit,
        delay_between=args.delay
    )
    
    log.info(f"\n=== Batch Evaluation Complete ===")
    log.info(f"Total sources: {results['total']}")
    log.info(f"Evaluated: {results['evaluated']}")
    log.info(f"Errors: {results['errors']}")
    
    if results['scores']:
        log.info(f"Average score: {results['avg_score']:.3f}")
        log.info(f"Score range: {results['min_score']:.3f} - {results['max_score']:.3f}")
        log.info(f"Tier distribution: {results['tiers']}")


if __name__ == "__main__":
    main()
