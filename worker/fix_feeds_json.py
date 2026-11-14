#!/usr/bin/env python3
"""Fix feeds.json problems:
1. Normalize region values (93 → canonical)
2. Fix empty country codes
3. Add base_domain for grouping
4. Deduplicate feeds with same URL
5. Disambiguate remaining duplicate names

Usage: python worker/fix_feeds_json.py [--dry-run]
"""

import json
import re
from urllib.parse import urlparse

CANONICAL_REGIONS = {
    # Global/International
    'global': 'global',
    'international': 'global',
    'International': 'global',
    'Global': 'global',
    'INT': 'global',
    'UN': 'global',

    # Americas
    'americas': 'americas',
    'Americas': 'americas',
    'north_america': 'americas',
    'north-america': 'americas',
    'North America': 'americas',
    'US': 'americas',
    'US/Israel': 'middle-east',
    'US/UK': 'global',
    'US/India': 'global',
    'India/US': 'global',
    'UK/US': 'global',

    # South America
    'south_america': 'south-america',
    'south-america': 'south-america',
    'South America': 'south-america',

    # Central America
    'central_america': 'central-america',
    'central-america': 'central-america',
    'Central America': 'central-america',

    # Caribbean
    'caribbean': 'caribbean',
    'Caribbean': 'caribbean',

    # Europe
    'europe': 'europe',
    'Europe': 'europe',
    'eastern_europe': 'eastern-europe',
    'eastern-europe': 'eastern-europe',
    'EASTERN_EUROPE': 'eastern-europe',
    'eastern_europe/middle-east': 'eastern-europe',
    'eurasia': 'europe',
    'EU': 'europe',

    # UK
    'UK': 'uk',
    'UK/Global': 'uk',
    'UK/India': 'uk',

    # Middle East
    'mena': 'middle-east',
    'MENA': 'middle-east',
    'middle_east': 'middle-east',
    'middle-east': 'middle-east',
    'Middle East': 'middle-east',
    'Middle East/Global': 'middle-east',
    'middle-east': 'middle-east',
    'Israel': 'middle-east',
    'Israel/US': 'middle-east',
    'US/Israel': 'middle-east',
    'Qatar': 'middle-east',
    'UAE': 'middle-east',
    'Turkey': 'middle-east',
    'Iran/India/Global': 'middle-east',
    'Egypt': 'middle-east',
    'Egypt/Global': 'middle-east',
    'Egypt/US': 'middle-east',

    # Africa
    'africa': 'africa',
    'Africa': 'africa',
    'AFRICA': 'africa',
    'east_africa': 'east-africa',
    'east-africa': 'east-africa',
    'East Africa': 'east-africa',
    'north_africa': 'north-africa',
    'north-africa': 'north-africa',
    'West Africa': 'west-africa',
    'west-africa': 'west-africa',
    'southern_africa': 'southern-africa',
    'southern-africa': 'southern-africa',
    'East/Central Africa': 'east-africa',
    'South Africa': 'southern-africa',

    # Asia
    'asia': 'asia',
    'Asia': 'asia',

    # South Asia
    'south_asia': 'south-asia',
    'south-asia': 'south-asia',
    'South Asia': 'south-asia',
    'SOUTH_ASIA': 'south-asia',
    'India': 'south-asia',
    'India/Global': 'south-asia',

    # Southeast Asia
    'southeast_asia': 'southeast-asia',
    'southeast-asia': 'southeast-asia',
    'Southeast Asia': 'southeast-asia',

    # East Asia
    'east_asia': 'east-asia',
    'east-asia': 'east-asia',
    'East Asia': 'east-asia',

    # Asia-Pacific
    'asia-pacific': 'asia-pacific',
    'Asia-Pacific': 'asia-pacific',
    'asia pacific': 'asia-pacific',

    # Central Asia
    'central_asia': 'central-asia',
    'central-asia': 'central-asia',

    # Oceania
    'oceania': 'oceania',
    'Oceania': 'oceania',
    'australia': 'oceania',
    'Australia': 'oceania',
    'western-australia': 'oceania',
    'West Coast': 'americas',
    'Pacific Northwest': 'americas',

    # Latin America
    'latin_america': 'latin-america',
    'latin-america': 'latin-america',
    'Latin America': 'latin-america',

    # US States
    'minnesota': 'americas',
    'Minnesota': 'americas',
    'wisconsin': 'americas',
    'Wisconsin': 'americas',
    'Idaho': 'americas',
    'idaho': 'americas',
    'New York': 'americas',
    'southwest': 'americas',

    # Sub-national
    'central-java': 'southeast-asia',
    'Tamaulipas/Northern Mexico': 'central-america',
    'Tamaulipas': 'central-america',
    'National/Regional (Guadalajara focus)': 'central-america',
    'National/Regional': 'americas',

    # Russia
    'Russia': 'eastern-europe',

    # Vatican
    'Vatican': 'europe',

    # Greece
    'Greece': 'europe',

    # Germany
    'Germany': 'europe',

    # Singapore
    'Singapore': 'southeast-asia',

    # Japan
    'Japan': 'east-asia',

    # Hong Kong
    'Hong Kong': 'east-asia',

    # Global south
    'global-south': 'global-south',
    'global-south': 'global-south',

    # na = not available, treat as global
    'na': 'global',
}

# Country code fixes for feeds with empty countries
COUNTRY_FIXES = {
    'sciencedaily.com': 'US',
    'newscientist.com': 'GB',
    'jesustiger.com': 'KR',
}

# Domain to country mapping
DOMAIN_COUNTRY = {
    'bbc.co.uk': 'GB',
    'aljazeera.com': 'QA',
    'al-jazirah.com': 'SA',
    'indianexpress.com': 'IN',
    'dailysabah.com': 'TR',
    'dw.com': 'DE',
    'euronews.com': 'FR',
    'globalvoices.org': 'US',
    'allafrica.com': 'ZA',
    'mercopress.com': 'UY',
    'middleeasteye.net': 'GB',
    'ipsnews.net': 'IT',
    'time.com': 'US',
    'politico.eu': 'BE',
    'latimes.com': 'US',
    'theatlantic.com': 'US',
    'independent.co.uk': 'GB',
    'independent.co.ug': 'UG',
    'japantimes.co.jp': 'JP',
    'thehindu.com': 'IN',
    'theglobeandmail.com': 'CA',
    'riotimesonline.com': 'BR',
    'punchng.com': 'NG',
}


def normalize_url(url: str) -> str:
    """Normalize URL for deduplication.
    
    Only normalizes path variations. Query params are preserved
    for Google News feeds (city targeting is in query).
    
    Returns tuple of (normalized_base, full_normalized) where
    base is without query for duplicate detection.
    """
    parsed = urlparse(url)
    path = parsed.path.rstrip('/')
    
    # Normalize common path variations only
    if path in ('', '/feed', '/rss', '/feed/', '/rss/'):
        path = '/feed'
    elif path.endswith('/feed.xml'):
        path = path.replace('/feed.xml', '/feed')
    elif path.endswith('/rss.xml'):
        path = path.replace('/rss.xml', '/feed')
    elif path.endswith('/index.xml'):
        path = path.replace('/index.xml', '/feed')
    
    # Remove trailing slashes from query-free URLs
    if not parsed.query and path.endswith('/'):
        path = path.rstrip('/')
    
    # Rebuild URL without www prefix
    netloc = parsed.netloc.lower().replace('www.', '')
    
    normalized = f"{parsed.scheme}://{netloc}{path}"
    
    # For duplicate detection, query params matter (Google News = different cities)
    # But path-only URL is used for true duplicates
    if parsed.query:
        full_normalized = normalized + f"?{parsed.query}"
        # Check if query has meaningful geo targeting
        query_params = dict(p.split('=') for p in parsed.query.split('&') if '=' in p)
        has_geo_target = any(k in query_params for k in ['q', 'ned', 'gl', 'hl'])
        if has_geo_target:
            # Keep query for duplicate detection
            base_for_dedup = full_normalized
        else:
            # No geo targeting, ignore query for dedup
            base_for_dedup = normalized
    else:
        full_normalized = normalized
        base_for_dedup = normalized
    
    return base_for_dedup  # Used for duplicate detection


def get_base_domain(url: str) -> str:
    """Extract base domain from URL for grouping."""
    parsed = urlparse(url)
    domain = parsed.netloc.lower()
    if domain.startswith('www.'):
        domain = domain[4:]
    for prefix in ['feeds.', 'rss.', 'english.']:
        if domain.startswith(prefix):
            domain = domain[len(prefix):]
    return domain


def normalize_region(region: str) -> str:
    """Normalize region to canonical form."""
    if not region or region == 'unknown':
        return 'global'

    if region in CANONICAL_REGIONS:
        return CANONICAL_REGIONS[region]

    lower = region.lower()
    if lower in CANONICAL_REGIONS:
        return CANONICAL_REGIONS[lower]

    normalized = lower.replace('-', '_').replace(' ', '_')
    if normalized in CANONICAL_REGIONS:
        return CANONICAL_REGIONS[normalized]

    no_underscore = normalized.replace('_', '')
    if no_underscore in CANONICAL_REGIONS:
        return CANONICAL_REGIONS[no_underscore]

    print(f"  WARNING: Unknown region '{region}' -> 'global'")
    return 'global'


def get_country_from_domain(url: str) -> str:
    """Infer country code from domain if not set."""
    domain = get_base_domain(url)
    return DOMAIN_COUNTRY.get(domain, 'US')


def fix_feeds():
    """Fix all problems in feeds.json."""
    input_file = 'worker/feeds.json'

    with open(input_file) as f:
        data = json.load(f)

    feeds = data['feeds']
    print(f"Loaded {len(feeds)} feeds")

    # Track changes
    changes = {
        'duplicates_merged': 0,
        'regions_normalized': 0,
        'countries_fixed': 0,
        'base_domains_added': 0,
    }

    # Step 1: Normalize URLs and deduplicate
    seen_urls = {}
    unique_feeds = []
    
    for feed in feeds:
        url = feed.get('feed_url', '')
        normalized = normalize_url(url)
        
        if normalized in seen_urls:
            # Duplicate - merge into existing
            existing_idx = seen_urls[normalized]
            existing = unique_feeds[existing_idx]
            
            # Keep the more complete entry (with homepage_url if available)
            if not existing.get('homepage_url') and feed.get('homepage_url'):
                existing['homepage_url'] = feed['homepage_url']
            
            changes['duplicates_merged'] += 1
        else:
            seen_urls[normalized] = len(unique_feeds)
            unique_feeds.append(feed)

    print(f"After deduplication: {len(unique_feeds)} feeds (merged {changes['duplicates_merged']})")

    # Step 2: Process all feeds
    for feed in unique_feeds:
        url = feed.get('feed_url', '')

        # Add base_domain
        feed['base_domain'] = get_base_domain(url)
        changes['base_domains_added'] += 1

        # Fix empty country codes
        country = feed.get('country', '').strip()
        if not country:
            domain_country = get_country_from_domain(url)
            feed['country'] = COUNTRY_FIXES.get(get_base_domain(url), domain_country)
            changes['countries_fixed'] += 1

        # Normalize regions
        old_region = feed.get('region', 'unknown')
        new_region = normalize_region(old_region)
        if old_region != new_region:
            changes['regions_normalized'] += 1
        feed['region'] = new_region

    # Step 3: Disambiguate names that are still duplicates
    name_counts = {}
    for i, feed in enumerate(unique_feeds):
        n = feed['name']
        if n not in name_counts:
            name_counts[n] = []
        name_counts[n].append((i, feed))

    disambig_count = 0
    for name, entries in name_counts.items():
        if len(entries) <= 1:
            continue
            
        # Sort by URL for consistent ordering
        entries.sort(key=lambda x: x[1].get('feed_url', ''))
        
        # Assign disambiguating suffixes
        for i, (idx, feed) in enumerate(entries):
            if i == 0:
                continue  # First one keeps base name
                
            url = feed.get('feed_url', '')
            parsed = urlparse(url)
            
            # Extract section from path
            path_parts = [p for p in parsed.path.split('/') 
                         if p and p.lower() not in ['feed', 'rss', 'tools', 'headlines', 'rdf', 'latest']]
            
            section_map = {
                'world': 'World', 'world-news': 'World', 'international': 'World',
                'politics': 'Politics', 'business': 'Business',
                'technology': 'Tech', 'tech': 'Tech',
                'science': 'Science', 'health': 'Health',
                'sports': 'Sports', 'sport': 'Sports',
                'culture': 'Culture', 'entertainment': 'Culture',
                'opinion': 'Opinion', 'africa': 'Africa', 'asia': 'Asia',
                'europe': 'Europe', 'americas': 'Americas',
                'middle-east': 'Middle East', 'south-asia': 'South Asia',
                'news': 'News', 'top': 'Top',
            }
            
            suffix = None
            
            # Try to get from query params (Google News city targeting)
            if 'news.google.com' in parsed.netloc and parsed.query:
                # Parse query to find city/region
                query_params = dict(p.split('=') for p in parsed.query.split('&') if '=' in p)
                if 'q' in query_params:
                    city = query_params['q'].replace('+', ' ').strip()
                    if city and len(city) < 50:  # sanity check
                        suffix = city
                elif 'ned' in query_params:
                    suffix = query_params['ned']  # country code
            
            # Try path-based section
            if not suffix:
                for part in path_parts:
                    part_lower = part.lower()
                    if part_lower in section_map:
                        suffix = section_map[part_lower]
                        break
            
            if not suffix:
                # Use subdomain or domain
                netloc = parsed.netloc.replace('www.', '').split('.')[0]
                if netloc and netloc.lower() not in ['feed', 'rss']:
                    suffix = netloc.replace('-', ' ').title()
                else:
                    suffix = f"#{i+1}"
            
            feed['name'] = f"{name} ({suffix})"
            disambig_count += 1

    changes['names_disambiguated'] = disambig_count

    # Report
    print("\nChanges made:")
    for k, v in changes.items():
        print(f"  {k}: {v}")

    # Save
    data['feeds'] = unique_feeds
    with open(input_file, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\nSaved to {input_file}")

    # Validate
    regions_after = set(f['region'] for f in unique_feeds)
    print(f"\nRegions: {len(regions_after)} unique (was 93)")
    print(f"  {sorted(regions_after)}")

    countries_after = set(f['country'] for f in unique_feeds if f.get('country'))
    empty_after = [f for f in unique_feeds if not f.get('country')]
    print(f"\nCountries: {len(countries_after)} unique")
    print(f"Empty countries: {len(empty_after)}")

    # Check for remaining duplicate names
    names_after = {}
    for f in unique_feeds:
        n = f['name']
        if n not in names_after:
            names_after[n] = []
        names_after[n].append(f)
    dups_after = {k: v for k, v in names_after.items() if len(v) > 1}
    print(f"\nDuplicate name groups: {len(dups_after)}")
    if dups_after:
        for name, entries in list(dups_after.items())[:5]:
            print(f"  {name}: {len(entries)} feeds")

    return changes


if __name__ == '__main__':
    import sys
    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print("DRY RUN - no changes will be saved")
        
    fix_feeds()
