"""Backfill geolocation data for recent interactions.

This script:
1. Gets all unique IP addresses from the last 24 hours of interactions
2. Looks up the geolocation for each IP address using ip-api.com
3. Updates the interactions with the geolocation data
4. Also updates the news_user_locations table

Usage:
    python -m worker.backfill_geolocations [--hours 24] [--batch-size 100]
"""

import argparse
import logging
import time
from datetime import datetime, timezone

import httpx

from .db import connect

log = logging.getLogger("xyzo.backfill_geolocations")

# ip-api.com rate limit: 45 requests per minute for free tier
# We'll be conservative and do 1 request per second
IP_API_URL = "http://ip-api.com/json/{ip}?fields=status,country,countryCode,regionName,city,lat,lon,timezone"
REQUEST_INTERVAL = 1.0  # seconds between requests
BATCH_SIZE = 100  # IPs to process per batch


def get_unique_ips(hours: int = 24) -> list[dict]:
    """Get unique IP addresses from interactions in the last N hours that don't have geolocation data."""
    with connect() as conn, conn.cursor() as cur:
        query = """
            SELECT DISTINCT 
                CASE 
                    WHEN ip_address::text LIKE '%%/32' THEN REPLACE(ip_address::text, '/32', '')
                    ELSE ip_address::text 
                END as ip,
                COUNT(*) as interaction_count
            FROM news_interactions
            WHERE created_at > now() - interval '%s hours'
              AND ip_address IS NOT NULL
              AND ip_address::text NOT IN ('127.0.0.1/32', '::1/128', 'localhost', 'unknown')
              AND (user_lat IS NULL OR user_lng IS NULL)
            GROUP BY ip_address
            ORDER BY interaction_count DESC
        """ % hours
        log.debug("Executing query: %s", query)
        cur.execute(query)
        results = cur.fetchall()
        log.debug("Found %d unique IPs: %s", len(results), [r['ip'] for r in results])
        return results


def lookup_ip_geolocation(ip: str) -> dict | None:
    """Look up geolocation for an IP address using ip-api.com."""
    try:
        url = IP_API_URL.format(ip=ip)
        with httpx.Client(timeout=10.0) as client:
            response = client.get(url)
            if response.status_code != 200:
                log.warning("ip-api.com HTTP %s for %s", response.status_code, ip)
                return None
            
            data = response.json()
            if data.get("status") != "success":
                log.warning("ip-api.com failed for %s: %s", ip, data.get("message", "unknown error"))
                return None
            
            return {
                "country": data.get("countryCode"),
                "city": data.get("city"),
                "lat": data.get("lat"),
                "lng": data.get("lon"),
                "region": data.get("regionName"),
                "timezone": data.get("timezone"),
            }
    except Exception as e:
        log.error("Error looking up IP %s: %s", ip, str(e))
        return None


def update_interactions_with_geolocation(ip: str, geo_data: dict) -> int:
    """Update all interactions for an IP address with geolocation data."""
    with connect() as conn, conn.cursor() as cur:
        # Handle both /32 and plain IP formats
        cur.execute("""
            UPDATE news_interactions
            SET user_lat = %s,
                user_lng = %s,
                user_country = %s,
                user_city = %s
            WHERE (ip_address::text = %s OR ip_address::text = %s)
              AND created_at > now() - interval '24 hours'
              AND (user_lat IS NULL OR user_lng IS NULL)
        """, (
            geo_data["lat"],
            geo_data["lng"],
            geo_data["country"],
            geo_data["city"],
            ip,
            ip + "/32",
        ))
        return cur.rowcount


def upsert_user_location(session_id: str, geo_data: dict) -> None:
    """Insert or update user location in news_user_locations table."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_user_locations (
                session_id, detected_lat, detected_lng, detected_city, detected_country,
                detected_at, active_lat, active_lng, active_source, last_seen_at
            ) VALUES (
                %s, %s, %s, %s, %s, now(), %s, %s, 'detected', now()
            )
            ON CONFLICT (session_id) DO UPDATE SET
                detected_lat = COALESCE(EXCLUDED.detected_lat, news_user_locations.detected_lat),
                detected_lng = COALESCE(EXCLUDED.detected_lng, news_user_locations.detected_lng),
                detected_city = COALESCE(EXCLUDED.detected_city, news_user_locations.detected_city),
                detected_country = COALESCE(EXCLUDED.detected_country, news_user_locations.detected_country),
                detected_at = now(),
                active_lat = COALESCE(EXCLUDED.detected_lat, news_user_locations.active_lat),
                active_lng = COALESCE(EXCLUDED.detected_lng, news_user_locations.active_lng),
                active_source = 'detected',
                last_seen_at = now()
        """, (
            session_id,
            geo_data["lat"],
            geo_data["lng"],
            geo_data["city"],
            geo_data["country"],
            geo_data["lat"],
            geo_data["lng"],
        ))


def get_sessions_for_ip(ip: str) -> list[str]:
    """Get all session IDs that have interactions from a specific IP address."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT session_id
            FROM news_interactions
            WHERE (ip_address::text = %s OR ip_address::text = %s)
              AND created_at > now() - interval '24 hours'
        """, (ip, ip + "/32"))
        return [row["session_id"] for row in cur.fetchall()]


def backfill_geolocations(hours: int = 24, batch_size: int = BATCH_SIZE) -> dict:
    """Main function to backfill geolocation data."""
    log.info("Starting geolocation backfill for last %d hours", hours)
    
    # Get unique IPs that need geolocation
    ips = get_unique_ips(hours)
    log.info("Found %d unique IPs needing geolocation", len(ips))
    
    if not ips:
        log.info("No IPs to process")
        return {"processed": 0, "updated": 0, "errors": 0, "sessions_updated": 0}
    
    stats = {
        "processed": 0,
        "updated": 0,
        "errors": 0,
        "sessions_updated": 0,
    }
    
    # Process IPs in batches
    for i in range(0, len(ips), batch_size):
        batch = ips[i:i + batch_size]
        log.info("Processing batch %d-%d of %d", i + 1, min(i + batch_size, len(ips)), len(ips))
        
        for ip_info in batch:
            ip = ip_info["ip"]
            interaction_count = ip_info["interaction_count"]
            
            # Look up geolocation
            geo_data = lookup_ip_geolocation(ip)
            if not geo_data:
                stats["errors"] += 1
                log.warning("Failed to geolocate IP %s (%d interactions)", ip, interaction_count)
                time.sleep(REQUEST_INTERVAL)
                continue
            
            # Update interactions
            updated_count = update_interactions_with_geolocation(ip, geo_data)
            stats["updated"] += updated_count
            
            # Update user locations for all sessions from this IP
            sessions = get_sessions_for_ip(ip)
            for session_id in sessions:
                upsert_user_location(session_id, geo_data)
                stats["sessions_updated"] += 1
            
            stats["processed"] += 1
            log.info("Processed IP %s: %s, %s (%d interactions updated)", 
                    ip, geo_data["city"], geo_data["country"], updated_count)
            
            # Rate limiting
            time.sleep(REQUEST_INTERVAL)
    
    log.info("Geolocation backfill complete: %d IPs processed, %d interactions updated, %d sessions updated, %d errors",
             stats["processed"], stats["updated"], stats["sessions_updated"], stats["errors"])
    
    return stats


def main():
    parser = argparse.ArgumentParser(description="Backfill geolocation data for recent interactions")
    parser.add_argument("--hours", type=int, default=24, help="Number of hours to look back (default: 24)")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help="Batch size for processing (default: 100)")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    
    args = parser.parse_args()
    
    # Configure logging
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    
    # Run backfill
    stats = backfill_geolocations(hours=args.hours, batch_size=args.batch_size)
    
    # Print summary
    print("\n" + "="*50)
    print("GEOLOCATION BACKFILL SUMMARY")
    print("="*50)
    print(f"IPs processed: {stats['processed']}")
    print(f"Interactions updated: {stats['updated']}")
    print(f"Sessions updated: {stats['sessions_updated']}")
    print(f"Errors: {stats['errors']}")
    print("="*50)


if __name__ == "__main__":
    main()