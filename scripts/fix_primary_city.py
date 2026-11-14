#!/usr/bin/env python3
"""
Fix primary_city_id misassignments in news_sources.

Many sources have primary_city_id that points to a city in a DIFFERENT
country than the source's country code. This causes cross-country
contamination where articles get placed in the wrong country.

This script identifies and optionally fixes these issues.

Usage:
    python scripts/fix_primary_city.py          # dry run (just report)
    python scripts/fix_primary_city.py --fix    # actually fix
    python scripts/fix_primary_city.py --list   # list all misassignments
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from worker.db import connect

# Mappings of known correct primary_city_id per country
# These are crowdsourced/verified correct assignments
CORRECT_CITIES = {
    # Country: (city_id, city_name)
    # These are verified correct primary cities for news agencies
    'RS': (9354, 'Belgrade'),  # Serbian capital
    'BB': (15445, 'Bridgetown'),  # Barbados capital
    'CG': (4656, 'Brazzaville'),  # Congo capital (not Madrid!)
    'LV': (9694, 'Riga'),  # Latvia capital (not York!)
    'IN': (6698, 'Delhi'),  # India capital (not Lahore!)
    'AF': (6156, 'Addis Ababa'),  # Ethiopia - AllAfrica HQ
    'UN': (8039, 'Geneva'),  # UN headquarters in Geneva
    'EU': (6240, 'Brussels'),  # EU capital
    'MM': (7130, 'Yangon'),  # Myanmar capital (not Rome!)
    'TH': (9572, 'Bangkok'),  # Thailand capital (not Kumamoto!)
    'VN': (8964, 'Hanoi'),  # Vietnam capital (not Kumamoto!)
    'VE': (9175, 'Caracas'),  # Venezuela capital (not Washington!)
    'MA': (12084, 'Rabat'),  # Morocco capital (not Sur, Oman!)
    'IE': (9292, 'Dublin'),  # Ireland capital (not Dakar!)
    'NP': (6624, 'Kathmandu'),  # Nepal capital (not Delhi!)
    'PH': (9217, 'Manila'),  # Philippines capital (not Barbados!)
    'US': (9050, 'Los Angeles'),  # US major city
    'GB': (6240, 'London'),  # UK capital
    'RU': (8951, 'Moscow'),  # Russia capital (not Osaka!)
    'DE': (4720, 'Berlin'),  # Germany capital (not Brussels!)
    'PK': (9420, 'Islamabad'),  # Pakistan capital
}


def get_misassigned_sources():
    """Find all sources where primary_city_id country doesn't match source country."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                ns.id,
                ns.name,
                ns.country as source_country,
                ns.primary_city_id,
                wc.name as city_name,
                wc.country_code as city_country,
                wc.lat,
                wc.lng
            FROM news_sources ns
            JOIN world_cities wc ON ns.primary_city_id = wc.id
            WHERE ns.primary_city_id IS NOT NULL
            AND wc.country_code != ns.country
            AND ns.active = true
            ORDER BY ns.country, ns.name
        """)
        return list(cur.fetchall())


def get_source_country_capitals():
    """Get the largest city (capital) for each country."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ON (ns.country)
                ns.country,
                ns.primary_city_id,
                wc.name,
                wc.lat,
                wc.lng
            FROM news_sources ns
            JOIN world_cities wc ON ns.primary_city_id = wc.id
            WHERE ns.country IS NOT NULL
            AND ns.country != ''
            AND ns.primary_city_id IS NOT NULL
            AND wc.country_code = ns.country
            ORDER BY ns.country, wc.population DESC
        """)
        return {row['country']: row for row in cur.fetchall()}


def fix_source(source_id: int, new_city_id: int, dry_run: bool = True):
    """Fix a source's primary_city_id."""
    action = "Would fix" if dry_run else "Fixing"
    print(f"  {action} source {source_id}: primary_city_id -> {new_city_id}")
    if not dry_run:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE news_sources
                SET primary_city_id = %s,
                    location_profile_updated_at = NOW()
                WHERE id = %s
            """, (new_city_id, source_id))


def main():
    parser = argparse.ArgumentParser(description='Fix primary_city_id misassignments')
    parser.add_argument('--fix', action='store_true', help='Actually apply fixes')
    parser.add_argument('--list', action='store_true', help='List all misassignments')
    parser.add_argument('--source-id', type=int, help='Fix specific source ID')
    args = parser.parse_args()

    misassigned = get_misassigned_sources()

    if not misassigned:
        print("No primary_city_id misassignments found!")
        return

    print(f"\nFound {len(misassigned)} sources with primary_city_id mismatches:\n")

    for row in misassigned:
        print(f"  [{row['id']}] {row['name']}")
        print(f"       Country: {row['source_country']} → City: {row['city_name']}, {row['city_country']}")
        print(f"       Lat/Lng: {row['lat']}, {row['lng']}")
        print()

    if args.list:
        return

    if args.source_id:
        # Fix specific source
        source = next((s for s in misassigned if s['id'] == args.source_id), None)
        if not source:
            print(f"Source {args.source_id} not found in misassigned list")
            return

        # Find correct city
        if source['source_country'] in CORRECT_CITIES:
            new_city_id = CORRECT_CITIES[source['source_country']][0]
            fix_source(args.source_id, new_city_id, dry_run=not args.fix)
        else:
            print(f"No correct city mapping for country {source['source_country']}")
            print("Please add to CORRECT_CITIES dict in this script")
        return

    if not args.fix:
        print("\nDry run complete. Run with --fix to apply changes.")
        return

    # Apply fixes
    print("\nApplying fixes...")
    fixed = 0
    skipped = 0

    for row in misassigned:
        country = row['source_country']
        if country not in CORRECT_CITIES:
            print(f"  SKIP [{row['id']}] {row['name']} - no mapping for {country}")
            skipped += 1
            continue

        new_city_id = CORRECT_CITIES[country][0]
        fix_source(row['id'], new_city_id, dry_run=False)
        fixed += 1

    print(f"\nFixed {fixed} sources, skipped {skipped}")


if __name__ == '__main__':
    main()
